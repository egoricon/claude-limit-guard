import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement, SessionMeasureInput } from 'claude-code'

const RESET = '2026-10-19T19:05:00+03:00'

function measure(percentUsed: number, resetsAt = RESET): SessionMeasureInput {
  return {
    context: { window: 200000 },
    rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt }],
    changed: ['rateLimits'],
  }
}

/** Stands in for the engine beneath the plugin; records aborted turns. */
function engine(on: On) {
  const aborted: string[] = []
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.abort', ($, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  return aborted
}

test('stops the running turn at the threshold, a typed prompt lifts the stop', async ($, on) => {
  const aborted = engine(on)
  const session = mock.session(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const footer = await $.ui.mount({ plugin: 'limit-guard', surface, component: 'SessionMode', props: { modes: [] } })
    expect(await footer.find({ key: 'lg-open' })).toBeDefined()
    await footer.unmount()
  }

  // Open the settings from the footer, then switch the guard on.
  const footer = await $.ui.mount({ plugin: 'limit-guard', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
  await footer.press({ key: 'lg-open' })
  const band = await $.ui.mount({
    plugin: 'limit-guard',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  await band.press({ key: 'lg-toggle' })

  await $.turn.start({ text: 'долгая задача', turnId: 't1' })
  await $.session.measure(measure(65))
  expect(aborted).toEqual([])

  await $.session.measure(measure(72))
  expect(aborted).toEqual(['t1'])
  expect(session.appended().length).toBe(1)

  // While stopped, tools are refused.
  // A typed "продолжи" lifts the stop; the task then runs to 100%.
  await $.prompt.submit({ text: 'продолжи', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'продолжи', turnId: 't2' })
  await $.session.measure(measure(85))
  expect(aborted).toEqual(['t1'])

  // A new 5-hour window resets the override: the guard watches again.
  await $.session.measure(measure(75, '2026-10-20T00:05:00+03:00'))
  expect(aborted).toEqual(['t1', 't2'])
})

test('switched off by default: nothing is stopped', async ($, on) => {
  const aborted = engine(on)
  await $.turn.start({ text: 'задача', turnId: 't1' })
  await $.session.measure(measure(99))
  expect(aborted).toEqual([])
})

test('background launches over the threshold: blocked by default, allowed by the switch', async ($, on) => {
  engine(on)
  const band = await $.ui.mount({
    plugin: 'limit-guard',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const footer = await $.ui.mount({ plugin: 'limit-guard', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
  await footer.press({ key: 'lg-open' })
  await band.press({ key: 'lg-toggle' })
  await $.session.measure(measure(90))

  const blocked = await $.prompt.submit({ text: 'cron', wait: false, origin: { kind: 'scheduled-trigger' } })
  expect('drop' in blocked && typeof blocked.drop === 'string').toBe(true)

  await band.press({ key: 'lg-bg' })
  const allowed = await $.prompt.submit({ text: 'cron', wait: false, origin: { kind: 'scheduled-trigger' } })
  expect(allowed).toEqual({ text: 'cron' })
})
