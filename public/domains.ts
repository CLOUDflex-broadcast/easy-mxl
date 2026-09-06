/**
 * Domains & Flows view: domain list + create form on the left, the selected
 * domain (metadata, options, mount snippet, attached containers, flow table)
 * on the right. Polls GET /api/domains/<name> every 2 s while visible.
 * @module domains
 */
import { api, domainPath } from './api.js';
import { DOMAIN_NAME_RE, flowStatusKind, formatAge, formatBytes, formatDateTime, plural, shortId, stateKind } from './format.js';
import { badge, bus, clear, confirmDialog, copyButton, el, icon, toast, toastError } from './ui.js';
import { openLogsPanel } from './logs.js';
import { openLaunchDialog } from './launch.js';

const POLL_MS = 2000;
const FLOW_COLUMNS = ['', 'Group', 'Role', 'Label', 'Flow ID', 'Format / summary', 'Status', 'Head index', 'Last write', 'Latency', 'Writer', 'Size', ''];

/**
 * Render a flow's latency with its unit (grains for discrete flows, samples for audio)
 * and the equivalent milliseconds derived from the header grain/sample rate.
 * @param {object} f Flow
 * @returns {string}
 */
function formatLatency(f) {
  const v = f.latencyGrains;
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '\u2014';
  const n = Number(v);
  const unit = f.format === 'audio' ? 'smp' : 'gr';
  const rate = f.header && f.header.grainRate;
  let ms = '';
  if (rate && Number(rate.numerator) > 0 && Number(rate.denominator) > 0) {
    const msValue = (n * Number(rate.denominator) * 1000) / Number(rate.numerator);
    ms = ` (${Math.abs(msValue) < 10 ? msValue.toFixed(1) : Math.round(msValue)} ms)`;
  }
  return `${n} ${unit}${ms}`;
}

/**
 * Render the domains view.
 * @param {HTMLElement} root
 * @param {{ name?: string|null }} [opts] selected domain name from the route
 * @returns {{ destroy: () => void }}
 */
export function renderDomainsView(root, { name = null } = {}) {
  let destroyed = false;
  let timer = null;
  let tick = 0;
  /** @type {any[]} */ let domains = [];
  /** @type {any[]} */ let attached = [];
  /** @type {any|null} */ let detail = null;
  const expanded = new Set();
  const selected = name;

  const listCount = el('span', { class: 'count' });
  const listEl = el('ul', { class: 'domain-items' });
  const listMsg = el('div', { class: 'placeholder hidden' });
  const detailEl = el('section', { class: 'domain-detail' });
  root.appendChild(el('div', { class: 'domains' },
    el('aside', { class: 'domain-list' }, el('h2', null, 'Domains', listCount), listMsg, listEl, createForm()),
    detailEl));

  /** @type {ReturnType<typeof buildDetail>|null} */
  let view = null;
  if (selected) {
    detailEl.appendChild(el('div', { class: 'placeholder' }, `Loading ${selected}…`));
  } else {
    detailEl.appendChild(el('div', { class: 'placeholder' }, 'Select a domain on the left, or create one.'));
  }

  /* ---------- polling ---------- */
  async function poll() {
    tick += 1;
    const tasks = [];
    if (tick % 3 === 1) tasks.push(loadList());
    if (selected) {
      tasks.push(loadDetail());
      if (tick % 3 === 1) tasks.push(loadAttached());
    }
    await Promise.all(tasks);
  }

  async function loop() {
    await poll();
    if (!destroyed) timer = setTimeout(loop, POLL_MS);
  }

  async function loadList() {
    try {
      const list = await api.get('/api/domains');
      domains = Array.isArray(list) ? list : [];
      listMsg.classList.add('hidden');
    } catch (err) {
      listMsg.textContent = `Cannot list domains: ${err.message}`;
      listMsg.classList.remove('hidden');
    }
    if (!destroyed) renderList();
  }

  async function loadDetail() {
    try {
      detail = await api.get(domainPath(selected));
      if (destroyed) return;
      if (!view) {
        view = buildDetail(detail);
        clear(detailEl);
        detailEl.appendChild(view.root);
      }
      view.update(detail);
    } catch (err) {
      if (destroyed) return;
      if (err.status === 404) {
        view = null;
        clear(detailEl);
        detailEl.appendChild(el('div', { class: 'placeholder' }, `Domain ${selected} does not exist (anymore). `, el('a', { href: '#/domains' }, 'Back to the list')));
      } else if (view) {
        view.setStatus(`refresh failed: ${err.message}`);
      } else {
        clear(detailEl);
        detailEl.appendChild(el('div', { class: 'error-box' }, `Cannot load domain ${selected}: ${err.message}`));
      }
    }
  }

  async function loadAttached() {
    try {
      const list = await api.get(domainPath(selected, '/containers'));
      attached = Array.isArray(list) ? list : [];
      if (view && detail && !destroyed) view.update(detail);
    } catch {
      /* attached containers are decoration; keep the previous list */
    }
  }

  /* ---------- left column ---------- */
  function renderList() {
    listCount.textContent = String(domains.length);
    clear(listEl);
    for (const d of domains) {
      const warnings = [];
      if (d.fs && d.fs.tmpfs === false) warnings.push(badge('not tmpfs', 'bad', 'Domain directory is not on tmpfs — MXL flows will hit disk'));
      if (d.def === null) warnings.push(badge('no domain_def.json', 'warn', 'Apps will not discover this directory as a domain'));
      listEl.appendChild(el('li', null, el('a', { href: `#/domains/${encodeURIComponent(d.name)}`, 'aria-current': d.name === selected ? 'true' : null },
        el('div', { class: 'name', text: d.name }),
        el('div', { class: 'meta' },
          d.def && d.def.label && d.def.label !== d.name ? el('span', { text: d.def.label }) : null,
          el('span', { text: `${d.activeFlowCount ?? 0} active / ${plural(d.flowCount ?? 0, 'flow')}` }),
          warnings))));
    }
    if (domains.length === 0 && listMsg.classList.contains('hidden')) listEl.appendChild(el('li', { class: 'placeholder' }, 'No domains yet.'));
  }

  function createForm() {
    const nameIn = el('input', { type: 'text', class: 'mono', placeholder: 'domain_1', required: true, spellcheck: 'false', 'aria-label': 'Domain name' });
    const labelIn = el('input', { type: 'text', placeholder: 'Studio A', 'aria-label': 'Label' });
    const descIn = el('input', { type: 'text', placeholder: 'optional', 'aria-label': 'Description' });
    const depthIn = el('input', { type: 'number', min: 1, step: 1, value: 200, class: 'mono', 'aria-label': 'Buffer depth in milliseconds' });
    const err = el('div', { class: 'err-text', role: 'alert' });
    const btn = el('button', { class: 'btn primary', type: 'submit' }, 'Create domain');
    const form = el('form', { class: 'domain-create', onSubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      const dn = nameIn.value.trim();
      if (!DOMAIN_NAME_RE.test(dn)) {
        err.textContent = 'Name: letters, digits, ".", "_" or "-", max 64 characters, starting with a letter or digit.';
        return;
      }
      const depth = Number(depthIn.value);
      const body = { name: dn, label: labelIn.value.trim() || dn };
      if (descIn.value.trim()) body.description = descIn.value.trim();
      if (depthIn.value !== '') {
        if (!Number.isFinite(depth) || depth <= 0) {
          err.textContent = 'Buffer depth must be a positive number of milliseconds.';
          return;
        }
        body.historyDurationMs = depth;
      }
      btn.disabled = true;
      try {
        const created = await api.post('/api/domains', body);
        toast(`Domain ${created.name} created`, { kind: 'success' });
        form.reset();
        depthIn.value = '200';
        location.hash = `#/domains/${encodeURIComponent(created.name)}`;
      } catch (e2) {
        err.textContent = e2.message;
      } finally {
        btn.disabled = false;
      }
    } },
    el('h3', { text: 'Create domain' }),
    el('label', { class: 'field' }, el('span', { class: 'lbl', text: 'Name' }), nameIn),
    el('label', { class: 'field' }, el('span', { class: 'lbl', text: 'Label' }), labelIn),
    el('label', { class: 'field' }, el('span', { class: 'lbl', text: 'Description' }), descIn),
    el('label', { class: 'field' }, el('span', { class: 'lbl', text: 'Buffer depth (ms)' }), depthIn, el('span', { class: 'help', text: 'history_duration option — ring buffer depth per flow, default 200 ms' })),
    err, btn);
    return form;
  }

  /* ---------- right column ---------- */
  function buildDetail(d) {
    const s = {
      label: el('span', { class: 'label' }),
      status: el('span', { class: 'dim', role: 'status' }),
      defWarn: el('div', { class: 'notice bad hidden' },
        el('span', null, 'missing domain_def.json — apps will not see this domain '),
        el('button', { class: 'btn sm', type: 'button', style: 'margin-left:8px', title: 'Write a new domain_def.json with a fresh id and this directory\'s name as label', onClick: () => repairDef() }, 'Fix: create domain_def.json')),
      fsWarn: el('div', { class: 'notice bad hidden' }, 'not on tmpfs — MXL flows will hit disk'),
      id: el('dd', { class: 'mono' }),
      description: el('dd'),
      fs: el('dd'),
      owner: el('dd', { class: 'mono' }),
      mtime: el('dd'),
      historyText: el('span'),
      historyIn: el('input', { type: 'number', min: 1, step: 1, class: 'mono', 'aria-label': 'History duration in milliseconds', style: 'width:110px' }),
      snippet: el('code'),
      attached: el('div', { class: 'attached' }),
      flowsCount: el('span', { class: 'count' }),
      tbody: el('tbody'),
    };
    const pathCode = el('code', { text: d.path || '' });
    const snippetText = () => `-v ${d.path}:/mxl-domain -e MXL_DOMAIN=/mxl-domain`;
    const repairDef = async () => {
      try {
        const updated = await api.post(domainPath(d.name, '/repair'));
        detail = updated;
        update(updated);
        toast(`domain_def.json created for ${d.name} (id ${updated.def && updated.def.id ? updated.def.id.slice(0, 8) : '?'}…)`, { kind: 'success' });
        loadList();
      } catch (err) {
        toastError(err, 'Could not create domain_def.json');
      }
    };
    const saveHistory = async (value) => {
      try {
        const updated = await api.patch(domainPath(d.name), { historyDurationMs: value });
        detail = updated;
        update(updated);
        toast(value === null ? 'History duration reset to default' : `History duration set to ${value} ms`, { kind: 'success' });
      } catch (err) {
        toastError(err, 'Update failed');
      }
    };
    const root = el('div', { class: 'domain-detail-inner', style: 'display:flex;flex-direction:column;min-height:100%' },
      el('div', { class: 'detail-head' }, el('h2', { text: d.name }), s.label, el('span', { class: 'spacer' }), s.status,
        el('button', { class: 'btn sm primary', type: 'button', onClick: () => openLaunchDialog({ domain: d.name }) }, 'Launch app here'),
        el('button', { class: 'btn sm danger', type: 'button', onClick: deleteDomain }, 'Delete domain')),
      el('div', { style: 'padding:0 14px' }, s.defWarn, s.fsWarn),
      el('div', { class: 'detail-meta' },
        el('dl', { class: 'kv' },
          el('dt', null, 'Path'), el('dd', null, el('span', { class: 'copy-row' }, pathCode, copyButton(d.path || '', 'domain path'))),
          el('dt', null, 'ID'), s.id,
          el('dt', null, 'Description'), s.description,
          el('dt', null, 'Filesystem'), s.fs,
          el('dt', null, 'Owner'), s.owner,
          el('dt', null, 'Modified'), s.mtime),
        el('div', null,
          el('h3', null, 'History duration'),
          el('div', { class: 'field-row', style: 'margin:6px 0 4px' }, s.historyIn,
            el('button', { class: 'btn sm', type: 'button', onClick: () => {
              const v = Number(s.historyIn.value);
              if (!Number.isFinite(v) || v <= 0) { toast('History duration must be a positive number of milliseconds.', { kind: 'error' }); return; }
              saveHistory(v);
            } }, 'Save'),
            el('button', { class: 'btn sm', type: 'button', title: 'Remove options.json entry (200 ms default)', onClick: () => saveHistory(null) }, 'Use default')),
          el('div', { class: 'help', style: 'margin-bottom:10px' }, s.historyText),
          el('h3', null, 'Mount snippet'),
          el('div', { class: 'snippet', style: 'margin-top:6px' }, s.snippet, copyButton(snippetText(), 'mount snippet')),
          el('h3', { style: 'margin-top:10px' }, 'Attached containers'),
          s.attached)),
      el('div', { class: 'flows-head' }, el('h2', null, 'Flows', s.flowsCount)),
      el('div', { class: 'flows-wrap' }, el('table', { class: 'grid flows' }, el('thead', null, el('tr', null, FLOW_COLUMNS.map((h) => el('th', { scope: 'col', text: h })))), s.tbody)));
    s.snippet.textContent = snippetText();

    let lastHistory;
    function update(dom) {
      s.label.textContent = dom.def && dom.def.label ? dom.def.label : '';
      s.status.textContent = '';
      s.defWarn.classList.toggle('hidden', dom.def !== null);
      s.fsWarn.classList.toggle('hidden', !(dom.fs && dom.fs.tmpfs === false));
      s.defWarn.firstChild.textContent = dom.def === null ? `${dom.defError && !/missing/.test(dom.defError) ? `unusable domain_def.json (${dom.defError})` : 'missing domain_def.json'} — apps will not see this domain ` : '';
      s.id.textContent = dom.def ? dom.def.id || '—' : dom.defError ? `domain_def.json: ${dom.defError}` : '—';
      s.description.textContent = (dom.def && dom.def.description) || '—';
      const fs = dom.fs || {};
      const used = Number.isFinite(fs.totalBytes) && Number.isFinite(fs.freeBytes) ? fs.totalBytes - fs.freeBytes : null;
      s.fs.textContent = `${fs.fsType || 'unknown'}${used !== null ? ` · ${formatBytes(used)} used of ${formatBytes(fs.totalBytes)}` : ''}`;
      s.owner.textContent = dom.owner ? `${dom.owner.uid}:${dom.owner.gid} ${dom.owner.mode}` : '—';
      s.mtime.textContent = formatDateTime(dom.mtime);
      s.historyText.textContent = dom.historyDurationMs === null || dom.historyDurationMs === undefined ? '200 ms (default, no options.json entry)' : `${dom.historyDurationMs} ms (${dom.historyDurationNs} ns in options.json)`;
      const current = dom.historyDurationMs ?? 200;
      if (document.activeElement !== s.historyIn && current !== lastHistory) s.historyIn.value = String(current);
      lastHistory = current;
      renderAttached(dom);
      renderFlows(dom);
    }

    function renderAttached(dom) {
      clear(s.attached);
      if (attached.length === 0) {
        s.attached.appendChild(el('span', { class: 'dim' }, 'none'));
        return;
      }
      for (const c of attached) {
        const mount = Array.isArray(c.domainMounts) ? c.domainMounts.find((mt) => mt.source === dom.path) || c.domainMounts[0] : null;
        s.attached.appendChild(el('button', { class: 'chip', type: 'button', title: `Open logs of ${c.name}`, onClick: () => openLogsPanel({ id: c.id, name: c.name }) },
          el('span', { class: 'mono', text: c.name }), badge(c.state, stateKind(c.state)),
          mount ? el('span', { class: 'dim mono', text: `${mount.destination} ${mount.readOnly ? 'ro' : 'rw'}` }) : null));
      }
    }

    function renderFlows(dom) {
      const flows = Array.isArray(dom.flows) ? dom.flows : [];
      const active = flows.filter((f) => f.status === 'active').length;
      s.flowsCount.textContent = `${active} active · ${flows.length} total`;
      clear(s.tbody);
      if (flows.length === 0) {
        s.tbody.appendChild(el('tr', null, el('td', { colspan: FLOW_COLUMNS.length, class: 'placeholder' }, 'No flows in this domain. Launch a source app that writes here.')));
        return;
      }
      for (const f of flows) s.tbody.append(...flowRows(dom, f));
    }

    function flowRows(dom, f) {
      const isOpen = expanded.has(f.id);
      const writer = f.writerContainer || (f.writerContainerId ? { id: f.writerContainerId, name: containerName(f.writerContainerId) } : null);
      const toggle = () => {
        if (expanded.has(f.id)) expanded.delete(f.id);
        else expanded.add(f.id);
        renderFlows(dom);
      };
      const tr = el('tr', { dataset: { id: f.id }, onClick: (e) => { if (!(e.target instanceof Element && e.target.closest('button, a, input'))) toggle(); } },
        el('td', null, el('button', { class: 'btn icon ghost', type: 'button', 'aria-expanded': String(isOpen), 'aria-label': `Details of flow ${f.label || f.id}`, onClick: (e) => { e.stopPropagation(); toggle(); } }, icon('chevron'))),
        el('td', { class: 'mono', text: f.group || '—' }),
        el('td', { class: 'mono', text: f.role || '—' }),
        el('td', null, f.label || el('span', { class: 'dim' }, '—'), f.defError ? el('div', { class: 'cell-sub', text: `flow_def.json: ${f.defError}` }) : null),
        el('td', null, el('span', { class: 'flow-id', title: f.id }, shortId(f.id, 8), copyButton(f.id, 'flow id'))),
        el('td', null, el('div', { text: f.summary || f.mediaType || f.format || '—' }), f.headerError ? el('div', { class: 'cell-sub', text: `header: ${f.headerError}` }) : null),
        el('td', null, badge(f.status || 'unknown', flowStatusKind(f.status), f.active === null ? 'Lock state unknown (/proc/locks not readable)' : undefined)),
        el('td', { class: 'num', text: f.header && f.header.headIndex !== undefined ? String(f.header.headIndex) : '—' }),
        el('td', { class: 'num', text: f.format === 'audio' ? '—' : formatAge(f.lastWriteAgeMs), title: f.headTimeIso ? `head grain time ${f.headTimeIso}` : null }),
        el('td', { class: 'num', text: formatLatency(f), title: 'Grains (video/data) or samples (audio) between the current time and the flow head' }),
        el('td', null, writer
          ? el('a', { href: '#', class: 'mono', title: `Logs of ${writer.id}`, onClick: (e) => { e.preventDefault(); openLogsPanel({ id: writer.id, name: writer.name || shortId(writer.id) }); } }, writer.name || shortId(writer.id))
          : f.writerPid ? el('span', { class: 'mono muted', text: `pid ${f.writerPid}` }) : el('span', { class: 'dim' }, '—')),
        el('td', { class: 'num', text: formatBytes(f.sizeBytes) }),
        el('td', { class: 'actions' }, f.status !== 'active' ? el('button', { class: 'btn sm danger', type: 'button', 'aria-label': `Delete flow ${f.label || f.id}`, onClick: () => deleteFlow(f) }, 'Delete') : null));
      if (!isOpen) return [tr];
      const json = (v, fallback) => el('pre', { text: v ? JSON.stringify(v, null, 2) : fallback || 'not available' });
      return [tr, el('tr', { class: 'detail-row' }, el('td', { colspan: FLOW_COLUMNS.length },
        el('div', { class: 'kv', style: 'margin-bottom:8px' }, el('dt', null, 'Directory'), el('dd', { class: 'mono', text: f.dir || '' }), el('dt', null, 'Grain files'), el('dd', { text: f.grainFiles === null || f.grainFiles === undefined ? '—' : String(f.grainFiles) })),
        el('div', { class: 'json-cols' },
          el('div', null, el('h3', null, 'flow_def.json'), json(f.def, f.defError)),
          el('div', null, el('h3', null, 'header (data)'), json(f.header, f.headerError)))))];
    }

    async function deleteFlow(f) {
      const label = f.label ? `${f.label} (${shortId(f.id, 8)})` : f.id;
      if (!(await confirmDialog({ title: 'Delete flow', message: `Delete flow ${label} from ${d.name}? The flow directory is removed from the domain.`, confirmLabel: 'Delete', danger: true }))) return;
      try {
        await api.del(domainPath(d.name, `/flows/${encodeURIComponent(f.id)}`));
        toast(`Flow ${shortId(f.id, 8)} deleted`, { kind: 'success' });
      } catch (err) {
        if (err.status === 409 && (await confirmDialog({ title: 'Flow is active', message: `${err.message} Force delete anyway? The writer will keep running with dangling files.`, confirmLabel: 'Force delete', danger: true }))) {
          try {
            await api.del(domainPath(d.name, `/flows/${encodeURIComponent(f.id)}`), { force: 1 });
          } catch (err2) {
            toastError(err2, 'Delete failed');
          }
        } else if (err.status !== 409) {
          toastError(err, 'Delete failed');
        }
      }
      loadDetail();
    }

    async function deleteDomain() {
      const running = attached.filter((c) => c.state === 'running').length;
      const info = running ? ` ${plural(running, 'running container')} still mount it.` : '';
      if (!(await confirmDialog({ title: 'Delete domain', message: `Delete domain ${d.name} and everything under ${d.path}?${info}`, confirmLabel: 'Delete', danger: true }))) return;
      try {
        await api.del(domainPath(d.name));
      } catch (err) {
        if (err.status !== 409) {
          toastError(err, 'Delete failed');
          return;
        }
        if (!(await confirmDialog({ title: 'Domain in use', message: `${err.message} Force delete anyway?`, confirmLabel: 'Force delete', danger: true }))) return;
        try {
          await api.del(domainPath(d.name), { force: 1 });
        } catch (err2) {
          toastError(err2, 'Delete failed');
          return;
        }
      }
      toast(`Domain ${d.name} deleted`, { kind: 'success' });
      location.hash = '#/domains';
    }

    return { root, update, setStatus: (t) => { s.status.textContent = t; } };
  }

  function containerName(id) {
    const c = attached.find((x) => x.id === id || (typeof x.id === 'string' && typeof id === 'string' && x.id.startsWith(id)));
    return c ? c.name : shortId(id);
  }

  const onContainer = () => { if (selected && !destroyed) loadAttached(); };
  bus.addEventListener('containers-changed', onContainer);
  loop();

  return {
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      bus.removeEventListener('containers-changed', onContainer);
    },
  };
}
