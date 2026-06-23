import { describe, it, expect } from 'vitest'
import { routeChannel } from './router'
import { PRODUCTION_OPS } from './commands'

describe('routeChannel', () => {
  it('routes every PRODUCTION_OPS channel to command', () => {
    for (const ch of PRODUCTION_OPS) expect(routeChannel(ch).kind).toBe('command')
  })
  it('routes reads + persistence + save to dedicated TS handlers', () => {
    expect(routeChannel('project_summary').kind).toBe('summary')
    expect(routeChannel('get_project_settings').kind).toBe('projectSettings')
    expect(routeChannel('project_open').kind).toBe('open')
    expect(routeChannel('project_save_as').kind).toBe('saveAs')
    expect(routeChannel('project_new_workspace').kind).toBe('newWorkspace')
    expect(routeChannel('project_save').kind).toBe('save')
  })
  it('rejects the two deferred renderer category-A channels', () => {
    expect(routeChannel('add_motif').kind).toBe('reject')
    expect(routeChannel('project_restore_checkpoint').kind).toBe('reject')
  })
  it('forwards independent stores + media/jobs/export to rust', () => {
    for (const ch of ['app_settings_get','app_settings_set','view_state_get','export_settings_get','recents_list','keybindings_get','agent_session_get','agent_session_end','log_list','import_media','ensure_full_proxy','export_video_sink_start','list_motifs','settings_test_provider','workspace_dir','ping'])
      expect(routeChannel(ch).kind).toBe('rust')
  })
  it('never routes a category-A state mutation to rust', () => {
    for (const ch of PRODUCTION_OPS) expect(routeChannel(ch).kind).not.toBe('rust')
  })
})
