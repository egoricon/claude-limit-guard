import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'

import type { Reading } from '../types'

/*
 * Limit Guard: останавливает автономную задачу в ЭТОМ чате, когда
 * 5-часовой лимит доходит до выбранного порога.
 *
 * - Всё состояние живёт в $.state, то есть отдельно для каждого чата:
 *   включил в одном чате, остальные работают как обычно.
 * - Процент лимита движок присылает сам (session.measure), когда он сдвинулся
 *   на целый пункт. Мод ничего не опрашивает и не тратит токены: сравнение
 *   двух чисел происходит вне модели.
 * - После остановки любое твоё сообщение ("продолжи") снимает стоп,
 *   и задача идёт до 100% лимита. Новый 5-часовой период сбрасывает это.
 */

const P = 'limit-guard'
const enabled = atom({ plugin: 'limit-guard', key: 'enabled' } as const, false)
const threshold = atom({ plugin: 'limit-guard', key: 'threshold' } as const, 70)
const reading = atom({ plugin: 'limit-guard', key: 'reading' } as const, null as Reading | null)
const tripped = atom({ plugin: 'limit-guard', key: 'tripped' } as const, false)
const override = atom({ plugin: 'limit-guard', key: 'override' } as const, false)
const isOpen = atom({ plugin: 'limit-guard', key: 'isOpen' } as const, false)
/** true: фоновые запуски (расписание, уведомления, другие агенты) идут и выше порога. */
const allowBackground = atom({ plugin: 'limit-guard', key: 'allowBackground' } as const, false)

const ORANGE = '#E8803A'
const RED = '#D93F3F'
const GREY = '#9A9A9A'
const STEPS = [30, 40, 50, 60, 65, 70, 75, 80, 85, 90, 95]
const HUMAN = new Set(['composer', 'bridge', 'sdk'])

type Look = { color: string; isLit: boolean; label: string }

function look(on: boolean, isTripped: boolean, isOverride: boolean): Look {
  if (!on) return { color: GREY, isLit: false, label: 'выключен' }
  if (isTripped) return { color: RED, isLit: true, label: 'остановлено' }
  if (isOverride) return { color: GREY, isLit: false, label: 'до 100%' }
  return { color: ORANGE, isLit: true, label: 'следит' }
}

function clamp(n: number) {
  return Math.max(0, Math.min(100, n))
}

/** Мини-ползунок: дорожка, заполнение до текущего %, засечка порога, кружок. */
function barSvg(percent: number | null, limit: number, l: Look) {
  const W = 96
  const x0 = 6
  const span = W - 12
  const p = clamp(percent ?? 0)
  const fx = x0 + (span * p) / 100
  const tx = x0 + (span * clamp(limit)) / 100
  const fill = l.isLit ? l.color : GREY
  const dot = l.isLit
    ? `<circle cx="${fx}" cy="8" r="5" fill="${l.color}"/>`
    : `<circle cx="${fx}" cy="8" r="4.5" fill="none" stroke="${GREY}" stroke-width="1.5"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="16" viewBox="0 0 ${W} 16">` +
    `<rect x="${x0}" y="6" width="${span}" height="4" rx="2" fill="${GREY}" opacity="0.35"/>` +
    `<rect x="${x0}" y="6" width="${fx - x0}" height="4" rx="2" fill="${fill}" opacity="0.85"/>` +
    `<rect x="${tx - 0.75}" y="2" width="1.5" height="12" rx="0.75" fill="${l.isLit ? l.color : GREY}"/>` +
    dot +
    `</svg>`
  )
}

/** Текстовая версия для терминала: ●━━━━━┃───. */
function barText(percent: number | null, limit: number, l: Look) {
  const cells = 10
  const at = Math.round((clamp(percent ?? 0) / 100) * cells)
  const mark = Math.round((clamp(limit) / 100) * cells)
  let s = ''
  for (let i = 0; i <= cells; i++) {
    if (i === at) s += l.isLit ? '●' : '○'
    else if (i === mark) s += '┃'
    else s += i < at ? '━' : '─'
  }
  return s
}

function resetTime(r: Reading | null) {
  if (!r?.resetsAt) return ''
  const d = new Date(r.resetsAt)
  if (isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

async function stop($: EngineInterface, running: string | undefined, why: string) {
  await update($, tripped, () => true)
  $.ui.toast(why)
  try {
    await $.session.append({
      message: { type: 'system', content: [{ type: 'text', text: why }] },
    })
  } catch {}
  if (running) {
    try {
      await $.turn.abort({ turnId: running })
    } catch {}
  }
}

/** Сравнить процент с порогом. Вызывается только когда процент сдвинулся. */
async function check($: EngineInterface, running: string | undefined) {
  if (!running) return
  if (!(await read($, enabled))) return
  if ((await read($, override)) || (await read($, tripped))) return
  const r = await read($, reading)
  const limit = await read($, threshold)
  if (!r || r.percent < limit) return
  const at = resetTime(r)
  await stop(
    $,
    running,
    `Limit Guard: использовано ${Math.round(r.percent)}% 5-часового лимита (порог ${limit}%). ` +
      `Задача остановлена${at ? `, лимит сбросится в ${at}` : ''}. ` +
      `Напиши «продолжи», чтобы работать дальше до 100%.`,
  )
}


export const register: Register = on => {
  /** Id главного хода, который сейчас идёт (подагенты не в счёт). */
  let running: string | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'limit-guard',
      description: 'Limit Guard: /limit-guard [on | off | <процент> | bg on | bg off]',
    })
    return next(e)
  })

  on('command.run', { command: 'limit-guard' }, async ($, e) => {
    const a = e.args.trim().toLowerCase()
    const bg = /^(bg|фон)\s+(on|off|вкл|выкл)$/.exec(a)
    if (bg) {
      const allow = bg[2] === 'on' || bg[2] === 'вкл'
      await update($, allowBackground, () => allow)
    } else if (a === 'on' || a === 'вкл') {
      await update($, enabled, () => true)
      await update($, tripped, () => false)
      await update($, override, () => false)
    } else if (a === 'off' || a === 'выкл') {
      await update($, enabled, () => false)
      await update($, tripped, () => false)
    } else if (/^\d{1,3}%?$/.test(a)) {
      const n = Math.max(1, Math.min(100, parseInt(a, 10)))
      await update($, threshold, () => n)
      await update($, tripped, () => false)
    }
    await update($, isOpen, () => true)
    const on_ = await read($, enabled)
    const t = await read($, threshold)
    const allowBg = await read($, allowBackground)
    return {
      text:
        `Limit Guard: ${on_ ? 'включён' : 'выключен'}, порог ${t}%, ` +
        `фоновые запуски выше порога ${allowBg ? 'разрешены' : 'блокируются'}.`,
    }
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) running = e.turnId
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined && e.turnId === running) running = undefined
    return next(e)
  })

  // Движок сам присылает свежие цифры лимита, когда они сдвинулись.
  on('session.measure', async ($, e, next) => {
    const w = e.rateLimits.find(r => r.kind === 'five_hour')
    if (w) {
      const prev = await read($, reading)
      const isNewWindow =
        prev !== null && !!prev.resetsAt && !!w.resetsAt && prev.resetsAt !== w.resetsAt
      if (isNewWindow) {
        await update($, override, () => false)
        await update($, tripped, () => false)
      }
      await update($, reading, () => ({ percent: w.percentUsed, resetsAt: w.resetsAt ?? null }))
      await check($, running)
    }
    return next(e)
  })

  // Страховка: пока стоит стоп, новые действия не выполняются.
  on('tool.call', async ($, e, next) => {
    if ((await read($, enabled)) && (await read($, tripped)) && !(await read($, override))) {
      return { deny: 'Limit Guard: порог лимита достигнут, задача остановлена.' }
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || !(await read($, enabled))) return next(e)
    const isHuman = HUMAN.has(e.origin.kind) && !e.isMeta
    if (isHuman) {
      // Ты сам написал после остановки: снимаем стоп, дальше до 100%.
      if (await read($, tripped)) {
        await update($, tripped, () => false)
        await update($, override, () => true)
        $.ui.toast('Limit Guard: продолжаю до 100% лимита в этом чате.')
      }
      return next(e)
    }
    // Автономный запуск (расписание, фоновое уведомление, другой агент).
    if (await read($, allowBackground)) return next(e)
    const r = await read($, reading)
    const limit = await read($, threshold)
    if (!(await read($, override)) && r && r.percent >= limit) {
      await update($, tripped, () => true)
      return { drop: `Limit Guard: ${Math.round(r.percent)}% лимита ≥ порога ${limit}%.` }
    }
    return next(e)
  })

  // Мини-ползунок в нижней строке поля ввода.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const base = await next(e)
    // Svg есть на десктопе и в мобильном приложении; в терминале рисуем текстом.
    const { Box, Button, Svg, Text } = $.ui.resolve(e) as unknown as ElementTable<'desktop'>
    const on_ = await read($, enabled)
    const l = look(on_, await read($, tripped), await read($, override))
    const r = await read($, reading)
    const limit = await read($, threshold)
    const pct = r ? `${Math.round(r.percent)}%` : '—'
    const alt = `Limit Guard ${l.label}: использовано ${pct}, стоп на ${limit}%`
    const toggle = () => update($, isOpen, v => !v)

    return (
      <Box flexDirection="row" alignItems="center" gap="xs">
        {base}
        {e.surface === 'terminal' ? (
          <Text color={l.isLit ? l.color : undefined} dimColor={!l.isLit}>
            {barText(r?.percent ?? null, limit, l)}
          </Text>
        ) : (
          <Svg source={barSvg(r?.percent ?? null, limit, l)} alt={alt} width={96} height={16} />
        )}
        <Button key="lg-open" plain dimColor onPress={toggle} label={`${pct} / ${limit}%`} />
      </Box>
    )
  })

  // Панель настроек над полем ввода (по нажатию на ползунок или /limit-guard).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOpen))) return next(e)
    // Select есть в терминале и на десктопе; в мобильном приложении — кнопки −5/+5.
    const { Box, Button, Select, Text } = $.ui.resolve(e) as unknown as ElementTable<'desktop'>
    const on_ = await read($, enabled)
    const isTripped = await read($, tripped)
    const isOverride = await read($, override)
    const l = look(on_, isTripped, isOverride)
    const r = await read($, reading)
    const limit = await read($, threshold)
    const at = resetTime(r)
    const allowBg = await read($, allowBackground)
    const isBelow = on_ && r !== null && r.percent >= limit && !isTripped && !isOverride

    const setLimit = async (n: number) => {
      await update($, threshold, () => Math.max(1, Math.min(100, n)))
      await update($, tripped, () => false)
    }
    const toggleOn = async () => {
      const next_ = !on_
      await update($, enabled, () => next_)
      await update($, tripped, () => false)
      if (next_) await update($, override, () => false)
    }

    return (
      <Box flexDirection="column" gap="xs">
        <Text weight="semibold">
          <Text color={l.isLit ? l.color : undefined}>{l.isLit ? '● ' : '○ '}</Text>
          Limit Guard · {l.label} · только этот чат
        </Text>
        <Text dimColor>
          5-часовой лимит: {r ? `${Math.round(r.percent)}%` : 'ещё нет данных'}
          {at ? ` · сброс в ${at}` : ''} · стоп на {limit}%
        </Text>
        <Box flexDirection="row" alignItems="center" gap="xs">
          <Button
            key="lg-toggle"
            variant="primary"
            label={on_ ? 'Выключить' : 'Включить'}
            onPress={toggleOn}
          />
          {e.surface !== 'mobile' ? (
            <Select
              key="lg-threshold"
              label="Стоп на"
              value={String(limit)}
              options={(STEPS.includes(limit) ? STEPS : [...STEPS, limit].sort((a, b) => a - b)).map(
                n => ({ value: String(n), label: `${n}%` }),
              )}
              onSelect={v => void setLimit(parseInt(v, 10))}
            />
          ) : (
            <Box flexDirection="row" gap="xs">
              <Button key="lg-minus" label="−5" onPress={() => setLimit(limit - 5)} />
              <Text>{limit}%</Text>
              <Button key="lg-plus" label="+5" onPress={() => setLimit(limit + 5)} />
            </Box>
          )}
          <Button key="lg-close" role="dismiss" label="Закрыть" onPress={() => update($, isOpen, () => false)} />
        </Box>
        <Box flexDirection="row" alignItems="center" gap="xs">
          <Text dimColor>Фоновые запуски выше порога:</Text>
          <Button
            key="lg-bg"
            label={allowBg ? 'разрешены' : 'блокируются'}
            onPress={() => update($, allowBackground, v => !v)}
          />
        </Box>
        {isTripped && (
          <Text color={RED}>Задача остановлена. Напиши «продолжи», чтобы работать до 100%.</Text>
        )}
        {isOverride && on_ && <Text dimColor>Ты разрешил работать до 100% до сброса лимита.</Text>}
        {isBelow && (
          <Text color={ORANGE}>Порог ниже текущего расхода: задача остановится при первом же обновлении.</Text>
        )}
      </Box>
    )
  })
}
