/**
 * Containers view: live table of all containers with actions.
 * Refreshes on 'containers-changed' bus events (debounced 300 ms in app.js)
 * and every 10 s as a fallback.
 * @module containers
 */
import { api, containerPath } from './api.js';
import { docsUrl, formatPorts, plural, shortId, stateKind, webUiUrl } from './format.js';
import { badge, bus, clear, confirmDialog, el, toast, toastError } from './ui.js';
import { openLogsPanel } from './logs.js';
import { openTerminalPanel } from './terminal.js';
import { openLaunchDialog } from './launch.js';

const POLL_MS = 10_000;

/**
 * Render the containers view into `root`.
 * @param {HTMLElement} root
 * @returns {{ destroy: () => void, refresh: () => Promise<void> }}
 */
export function renderContainersView(root) {
  /** @type {any[]} */ let containers = [];
  let loaded = false;
  let destroyed = false;
  let inflight = null;
  let showStopped = true;
  const busy = new Set();

  const count = el('span', { class: 'count' });
  const toggle = el('input', { type: 'checkbox', checked: true, onChange: () => { showStopped = toggle.checked; render(); } });
  const message = el('div', { class: 'error-box hidden', role: 'alert' });
  const tbody = el('tbody');
  const table = el('table', { class: 'grid' },
    el('thead', null, el('tr', null, ['Name', 'App / image', 'State', 'Ports', 'Domain', ''].map((h) => el('th', { scope: 'col', text: h })))),
    tbody);
  const empty = el('div', { class: 'empty hidden' });
  root.append(
    el('div', { class: 'toolbar' }, el('h2', null, 'Containers', count), el('span', { class: 'spacer' }),
      el('label', { class: 'check' }, toggle, 'show stopped'),
      el('button', { class: 'btn sm', type: 'button', onClick: () => refresh() }, 'Refresh')),
    message,
    el('div', { class: 'table-wrap' }, table, empty),
  );

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const list = await api.get('/api/containers');
        containers = Array.isArray(list) ? list : [];
        loaded = true;
        message.classList.add('hidden');
      } catch (err) {
        message.textContent = `Cannot load containers: ${err.message}`;
        message.classList.remove('hidden');
      } finally {
        inflight = null;
      }
      if (!destroyed) render();
    })();
    return inflight;
  }

  function render() {
    const visible = (showStopped ? containers : containers.filter((c) => c.state === 'running'))
      .slice()
      .sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || String(a.name).localeCompare(String(b.name)));
    const running = containers.filter((c) => c.state === 'running').length;
    count.textContent = loaded ? `${running} running · ${containers.length} total` : '';
    clear(tbody);
    for (const c of visible) tbody.appendChild(row(c));
    clear(empty);
    if (loaded && visible.length === 0) {
      if (containers.length === 0) {
        empty.append(el('p', null, 'No containers yet.'), el('button', { class: 'btn primary', type: 'button', onClick: () => openLaunchDialog() }, 'Launch app'));
      } else {
        empty.append(el('p', null, `No running containers — ${plural(containers.length, 'stopped container')} hidden.`));
      }
    }
    empty.classList.toggle('hidden', !(loaded && visible.length === 0));
    table.classList.toggle('hidden', visible.length === 0);
  }

  function row(c) {
    const running = c.state === 'running';
    const ui = webUiUrl(c.webUI);
    const docs = docsUrl(c.webUI);
    const ports = formatPorts(c.ports);
    const mount = Array.isArray(c.domainMounts) && c.domainMounts[0];
    return el('tr', { class: busy.has(c.id) ? 'busy' : null, dataset: { id: c.id } },
      el('td', null, el('div', { class: 'cell-title mono', text: c.name }), el('div', { class: 'cell-sub mono', title: c.id, text: shortId(c.id) })),
      el('td', null, el('div', { class: 'cell-title' }, c.app || (c.managed ? 'managed' : el('span', { class: 'dim' }, 'unmanaged'))), el('div', { class: 'cell-sub mono', text: c.image || '' })),
      el('td', null, badge(c.state || 'unknown', stateKind(c.state), c.status || undefined),
        !running && c.exitCode !== null && c.exitCode !== undefined ? el('div', { class: 'cell-sub', text: `exit ${c.exitCode}` }) : null),
      el('td', null, c.networkMode === 'host' ? el('span', { class: 'muted' }, 'host network') : ports.length ? el('div', { class: 'ports mono' }, ports.map((p) => el('span', { text: p }))) : el('span', { class: 'dim' }, '—')),
      el('td', null,
        c.domain ? el('a', { class: 'mono', href: `#/domains/${encodeURIComponent(c.domain)}`, text: c.domain }) : c.domainPath ? el('span', { class: 'mono', text: c.domainPath }) : el('span', { class: 'dim' }, '—'),
        mount ? el('div', { class: 'cell-sub mono', text: `${mount.destination}${mount.readOnly ? ' (ro)' : ''}` }) : null),
      el('td', { class: 'actions' },
        ui ? el('a', { class: 'btn sm', href: ui, target: '_blank', rel: 'noopener', title: c.webUI && c.webUI.inferred ? 'guessed from published port' : ui }, 'Open UI') : null,
        docs ? el('a', { class: 'btn sm', href: docs, target: '_blank', rel: 'noopener', title: docs }, 'API docs') : null,
        el('button', { class: 'btn sm', type: 'button', onClick: () => openLogsPanel({ id: c.id, name: c.name }) }, 'Logs'),
        running ? el('button', { class: 'btn sm', type: 'button', onClick: () => openTerminalPanel({ id: c.id, name: c.name }) }, 'Terminal') : null,
        running
          ? el('button', { class: 'btn sm', type: 'button', disabled: busy.has(c.id), onClick: () => stop(c) }, 'Stop')
          : el('button', { class: 'btn sm', type: 'button', disabled: busy.has(c.id) || c.state === 'removing', onClick: () => act(c, 'start', 'Start') }, 'Start'),
        running ? el('button', { class: 'btn sm', type: 'button', disabled: busy.has(c.id), onClick: () => act(c, 'restart', 'Restart') }, 'Restart') : null,
        el('button', { class: 'btn sm danger', type: 'button', disabled: busy.has(c.id), 'aria-label': `Remove ${c.name}`, onClick: () => remove(c) }, 'Remove')));
  }

  async function run(c, label, fn) {
    busy.add(c.id);
    render();
    try {
      await fn();
      toast(`${label}: ${c.name}`, { kind: 'success' });
    } catch (err) {
      toastError(err, `${label} ${c.name} failed`);
    } finally {
      busy.delete(c.id);
      if (!destroyed) refresh();
    }
  }

  const act = (c, verb, label) => run(c, label, () => api.post(containerPath(c.id, `/${verb}`)));

  async function stop(c) {
    if (!(await confirmDialog({ title: 'Stop container', message: `Stop ${c.name}? The process gets SIGTERM and 10 s to exit.`, confirmLabel: 'Stop' }))) return;
    act(c, 'stop', 'Stopped');
  }

  async function remove(c) {
    const running = c.state === 'running';
    const ok = await confirmDialog({
      title: 'Remove container',
      message: running ? `${c.name} is running. It will be killed and removed. Its MXL flows stay in the domain until deleted.` : `Remove ${c.name}? This cannot be undone.`,
      confirmLabel: running ? 'Kill & remove' : 'Remove',
      danger: true,
    });
    if (!ok) return;
    run(c, 'Removed', () => api.del(containerPath(c.id), running ? { force: 1 } : undefined));
  }

  const onChanged = () => refresh();
  bus.addEventListener('containers-changed', onChanged);
  const timer = setInterval(refresh, POLL_MS);
  refresh();

  return {
    destroy() {
      destroyed = true;
      clearInterval(timer);
      bus.removeEventListener('containers-changed', onChanged);
    },
    refresh,
  };
}
