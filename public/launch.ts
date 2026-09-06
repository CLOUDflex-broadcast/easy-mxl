/**
 * Launch dialog: app picker → parameter form → job progress → result.
 * Talks to POST /api/apps/:id/launch, GET /api/jobs/:id (1 s poll) and the
 * 'job' bus events relayed from /ws/events.
 * @module launch
 */
import { api, containerPath } from './api.js';
import { CONTAINER_NAME_RE, DOMAIN_NAME_RE, formatBytes, parseEnvLines, stateKind, webUiUrl } from './format.js';
import { badge, bus, clear, el, openModal, spinner, toast, toastError } from './ui.js';
import { openLogsPanel } from './logs.js';

const CATEGORY_ORDER = ['source', 'processing', 'output', 'monitoring', 'infrastructure', 'tools'];
const CATEGORY_LABEL = { source: 'Sources', processing: 'Processing', output: 'Outputs', monitoring: 'Monitoring', infrastructure: 'Infrastructure', tools: 'Tools' };
const CREATE_OPTION = '__create__';

/**
 * Open the launch dialog.
 * @param {{ appId?: string|null, domain?: string|null }} [opts] preselected app / domain name
 */
export async function openLaunchDialog({ appId = null, domain = null } = {}) {
  /** @type {any[]} */ let apps = [];
  /** @type {any[]} */ let domains = [];
  /** @type {{ app: any, params: any } | null} */ let current = null;
  let jobId = null;
  let pollTimer = null;
  let pollFailures = 0;

  const onJob = (ev) => applyJob(ev.detail);
  bus.addEventListener('job', onJob);
  const m = openModal({ title: 'Launch app', className: 'wide launch', dismissible: false, onClose: () => { bus.removeEventListener('job', onJob); stopPolling(); } });

  function footer(...buttons) {
    clear(m.foot);
    m.foot.append(...buttons.filter(Boolean));
  }
  const cancelBtn = (label = 'Cancel') => el('button', { class: 'btn', type: 'button', onClick: () => m.close() }, label);

  m.body.append(spinner(), ' Loading catalog…');
  footer(cancelBtn());
  try {
    [apps, domains] = await Promise.all([api.get('/api/apps'), api.get('/api/domains').catch(() => [])]);
  } catch (err) {
    clear(m.body);
    m.body.appendChild(el('div', { class: 'error-box' }, `Cannot load the app catalog: ${err.message}`));
    return;
  }
  if (!Array.isArray(apps)) apps = [];
  if (!Array.isArray(domains)) domains = [];
  const preselected = appId ? apps.find((a) => a.id === appId) : null;
  if (preselected) showForm(preselected);
  else showApps();

  /* ---------- step 1: app cards ---------- */
  function showApps() {
    m.titleEl.textContent = 'Launch app';
    clear(m.body);
    if (apps.length === 0) {
      m.body.appendChild(el('p', { class: 'muted' }, 'The catalog is empty — add apps with --catalog <file>.'));
    }
    const byCat = new Map();
    for (const a of apps) {
      const c = a.category || 'tools';
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(a);
    }
    const order = (c) => { const i = CATEGORY_ORDER.indexOf(c); return i === -1 ? CATEGORY_ORDER.length : i; };
    for (const cat of [...byCat.keys()].sort((a, b) => order(a) - order(b))) {
      m.body.appendChild(el('section', { class: 'app-cat' }, el('h3', { text: CATEGORY_LABEL[cat] || cat }), el('div', { class: 'app-cards' }, byCat.get(cat).map(appCard))));
    }
    footer(cancelBtn());
  }

  function appCard(app) {
    const existing = Array.isArray(app.containers) ? app.containers : [];
    return el('button', { class: 'app-card', type: 'button', onClick: () => showForm(app) },
      el('div', { class: 'title' }, app.name || app.id,
        app.imagePresent === false ? badge(app.imagePolicy === 'local' ? 'image not loaded' : 'image not pulled yet', 'warn') : null,
        Array.isArray(app.requires) && app.requires.length ? badge(`needs ${app.requires.join(', ')}`, 'info') : null),
      el('div', { class: 'desc', text: app.description || '' }),
      el('div', { class: 'img mono', text: app.image || '' }),
      app.imagePolicy === 'local' ? el('div', { class: 'dim', text: 'loaded from a .tar archive (docker load)' }) : null,
      existing.length ? el('div', { class: 'existing' }, existing.map((c) => badge(`${c.name} · ${c.state}`, stateKind(c.state)))) : null);
  }

  /* ---------- step 2: form ---------- */
  function showForm(app) {
    m.titleEl.textContent = `Launch ${app.name || app.id}`;
    clear(m.body);
    const f = { domain: null, name: null, image: null, ports: [], hostPaths: [], params: [], requires: null, env: null, pull: null };
    const local = app.imagePolicy === 'local';
    let launchBlocked = false;
    const form = el('form', { class: 'launch-form', onSubmit: (e) => { e.preventDefault(); submit(); } });
    form.appendChild(el('p', { class: 'muted' }, app.description || '', ' ', el('span', { class: 'mono dim', text: app.image || '' })));
    if (local) {
      const images = Array.isArray(app.localImages) ? app.localImages : [];
      if (images.length) {
        f.image = el('select', { class: 'mono', 'aria-label': 'Image' }, images.map((img) => el('option', { value: img.ref }, `${img.ref} · ${formatBytes(img.size)} · ${img.created ? new Date(img.created).toLocaleDateString() : 'unknown date'}`)));
        if (images.some((img) => img.ref === app.image)) f.image.value = app.image;
        form.appendChild(field('Image (loaded on this host)', f.image, 'This app is delivered as an archive; pick the tag you loaded with docker load.'));
      } else {
        launchBlocked = true;
        form.appendChild(el('div', { class: 'notice warn' },
          `No ${(Array.isArray(app.imageRepositories) && app.imageRepositories.length ? app.imageRepositories : [app.imageRepository || app.image]).join(' / ')} image is loaded on this host. Load the delivered archive first: `,
          el('code', { class: 'mono' }, 'docker load -i <archive>.tar'),
          ' — then reopen this dialog.'));
      }
    } else if (app.imagePresent === false) {
      form.appendChild(el('div', { class: 'notice warn' }, 'The image is not present on this host yet — it will be pulled first, which can take a while.'));
    }
    if (app.notes) form.appendChild(el('div', { class: 'notice info', text: app.notes }));

    if (app.domainMount) form.appendChild(domainField(f, app));
    f.name = el('input', { type: 'text', class: 'mono', value: app.containerName || app.id, spellcheck: 'false', 'aria-label': 'Container name' });
    form.appendChild(field('Container name', f.name, app.domainMount ? `Domain mounted at ${app.domainMount.containerPath}${app.domainMount.readOnly ? ' (read-only)' : ''}` : null));

    const ports = Array.isArray(app.ports) ? app.ports : [];
    if (app.networkMode === 'host') {
      form.appendChild(el('div', { class: 'notice info' }, 'Host networking: the container shares the host network stack, no ports are published.'));
    } else if (ports.length) {
      form.appendChild(el('h3', { class: 'section', text: 'Host ports' }));
      const grid = el('div', { class: 'grid-2' });
      for (const p of ports) {
        const protocol = p.protocol || 'tcp';
        const key = `${p.containerPort}/${protocol}`;
        const out = el('span', { class: 'warn-text', role: 'status' });
        const input = el('input', { type: 'number', min: 1, max: 65535, class: 'mono', value: p.hostPort ?? p.containerPort, 'aria-label': `Host port for ${key}` });
        const check = () => checkPort(input, protocol, out);
        input.addEventListener('change', check);
        input.addEventListener('blur', check);
        f.ports.push({ key, input });
        const range = p.rangeEnd ? `${p.containerPort}-${p.rangeEnd}` : String(p.containerPort);
        grid.appendChild(field(`Host port → ${range}/${protocol}${p.rangeEnd ? ' (range start)' : ''}`, input, null, out));
        check();
      }
      form.appendChild(grid);
    }

    const hostPaths = Array.isArray(app.hostPaths) ? app.hostPaths : [];
    if (hostPaths.length) {
      form.appendChild(el('h3', { class: 'section', text: 'Host paths' }));
      for (const spec of hostPaths) {
        const input = el('input', { type: 'text', class: 'mono', value: spec.default || '', placeholder: '/absolute/path/on/host', required: !!spec.required, spellcheck: 'false' });
        f.hostPaths.push({ spec, input });
        form.appendChild(field(`${spec.label || spec.key}${spec.required ? ' *' : ''}`, input, `→ ${spec.containerPath}${spec.readOnly ? ' (read-only)' : ''}`));
      }
    }

    const params = Array.isArray(app.params) ? app.params : [];
    if (params.length) {
      form.appendChild(el('h3', { class: 'section', text: 'Parameters' }));
      const grid = el('div', { class: 'grid-2' });
      for (const spec of params) {
        const input = el('input', { type: 'text', value: spec.default ?? '' });
        f.params.push({ spec, input });
        grid.appendChild(field(spec.label || spec.key, input, spec.help || null));
      }
      form.appendChild(grid);
    }

    if (Array.isArray(app.requires) && app.requires.length) {
      f.requires = el('input', { type: 'checkbox', checked: true });
      form.appendChild(el('div', { class: 'field' }, el('label', { class: 'check' }, f.requires, `Also launch required apps (${app.requires.join(', ')})`)));
    }

    f.env = el('textarea', { class: 'mono', rows: 3, placeholder: 'KEY=VALUE, one per line', spellcheck: 'false' });
    f.pull = el('select', { 'aria-label': 'Pull policy' }, el('option', { value: 'missing' }, 'pull only when the image is missing'), el('option', { value: 'always' }, 'always pull before starting'));
    form.appendChild(el('details', { class: 'adv' }, el('summary', null, 'Advanced'), field('Extra environment', f.env, 'Merged over the app defaults.'), local ? null : field('Pull policy', f.pull)));

    m.body.appendChild(form);
    const launchBtn = el('button', { class: 'btn primary', type: 'button', 'data-autofocus': true, onClick: () => form.requestSubmit() }, 'Launch');
    if (launchBlocked) {
      launchBtn.disabled = true;
      launchBtn.title = 'Load the image archive with docker load first';
    }
    footer(
      el('button', { class: 'btn', type: 'button', onClick: showApps }, 'Back'),
      cancelBtn(),
      launchBtn,
    );

    function submit() {
      let params;
      try {
        params = collect(app, f);
      } catch (err) {
        toast(err.message, { kind: 'error' });
        return;
      }
      launch(app, params);
    }
  }

  function field(label, input, help, extra) {
    return el('label', { class: 'field' }, el('span', { class: 'lbl', text: label }), input, help ? el('span', { class: 'help', text: help }) : null, extra || null);
  }

  function domainField(f, app) {
    f.domain = el('select', { 'aria-label': 'MXL domain' });
    const createBox = el('div', { class: 'inline-form hidden' });
    const nameIn = el('input', { type: 'text', class: 'mono', placeholder: 'domain_1', pattern: DOMAIN_NAME_RE.source, spellcheck: 'false' });
    const labelIn = el('input', { type: 'text', placeholder: 'Studio A' });
    const depthIn = el('input', { type: 'number', min: 1, value: 200, class: 'mono' });
    createBox.append(
      el('div', { class: 'grid-2' }, field('Domain name', nameIn), field('Label', labelIn), field('Buffer depth (ms)', depthIn, 'history_duration option; default 200 ms')),
      el('button', { class: 'btn', type: 'button', onClick: createDomainInline }, 'Create domain'),
    );
    function fillOptions(selectedName) {
      clear(f.domain);
      for (const d of domains) {
        const label = d.def && d.def.label && d.def.label !== d.name ? ` — ${d.def.label}` : '';
        f.domain.appendChild(el('option', { value: d.name, disabled: d.def === null }, `${d.name}${label}${d.def === null ? ' (missing domain_def.json — use Fix under Domains & Flows)' : ''}`));
      }
      f.domain.appendChild(el('option', { value: CREATE_OPTION }, '+ create domain…'));
      const usable = domains.filter((d) => d.def !== null).map((d) => d.name);
      f.domain.value = selectedName && usable.includes(selectedName) ? selectedName : usable[0] || CREATE_OPTION;
      createBox.classList.toggle('hidden', f.domain.value !== CREATE_OPTION);
    }
    f.domain.addEventListener('change', () => createBox.classList.toggle('hidden', f.domain.value !== CREATE_OPTION));
    async function createDomainInline() {
      const name = nameIn.value.trim();
      if (!DOMAIN_NAME_RE.test(name)) {
        toast('Domain name: letters, digits, ".", "_" or "-", max 64 characters, starting with a letter or digit.', { kind: 'error' });
        return;
      }
      const depth = Number(depthIn.value);
      const body = { name, label: labelIn.value.trim() || name };
      if (Number.isFinite(depth) && depth > 0) body.historyDurationMs = depth;
      try {
        const created = await api.post('/api/domains', body);
        domains = [...domains.filter((d) => d.name !== created.name), created].sort((a, b) => a.name.localeCompare(b.name));
        fillOptions(created.name);
        toast(`Domain ${created.name} created`, { kind: 'success' });
      } catch (err) {
        toastError(err, 'Create domain failed');
      }
    }
    fillOptions(domain);
    return el('div', null, field(`MXL domain (mounted at ${app.domainMount.containerPath})`, f.domain), createBox);
  }

  async function checkPort(input, protocol, out) {
    out.textContent = '';
    const port = Number(input.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    try {
      const r = await api.get('/api/ports/check', { port, protocol });
      if (Number(input.value) !== port) return;
      if (r && r.container) out.textContent = `in use by ${r.container.name}${r.container.state ? ` (${r.container.state})` : ''}`;
      else if (r && r.listening) out.textContent = 'port is already listening on this host';
    } catch {
      /* advisory only */
    }
  }

  /** Build LaunchParams from the form; throws Error with a user message. */
  function collect(app, f) {
    const params = { launchRequires: f.requires ? f.requires.checked : true };
    if (app.imagePolicy !== 'local') params.pull = f.pull.value;
    if (f.image && f.image.value) params.image = f.image.value;
    if (app.domainMount) {
      if (!f.domain.value || f.domain.value === CREATE_OPTION) throw new Error('Select a domain, or create one first.');
      params.domain = f.domain.value;
    } else {
      params.domain = null;
    }
    const name = f.name.value.trim();
    if (name) {
      if (!CONTAINER_NAME_RE.test(name)) throw new Error('Container name: letters, digits, "_", "." or "-", at least 2 characters, starting with a letter or digit.');
      params.name = name;
    }
    if (f.ports.length) {
      params.hostPorts = {};
      for (const p of f.ports) {
        const v = Number(p.input.value);
        if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`Host port for ${p.key} must be between 1 and 65535.`);
        params.hostPorts[p.key] = v;
      }
    }
    if (f.hostPaths.length) {
      params.hostPaths = {};
      for (const h of f.hostPaths) {
        const v = h.input.value.trim();
        const label = h.spec.label || h.spec.key;
        if (!v) {
          if (h.spec.required) throw new Error(`${label} is required.`);
          continue;
        }
        if (!v.startsWith('/')) throw new Error(`${label} must be an absolute path on the host.`);
        params.hostPaths[h.spec.key] = v;
      }
    }
    if (f.params.length) {
      params.params = {};
      for (const p of f.params) params.params[p.spec.key] = p.input.value;
    }
    const env = parseEnvLines(f.env.value);
    if (Object.keys(env).length) params.env = env;
    return params;
  }

  /* ---------- step 3: progress ---------- */
  const progressMsg = el('div', { class: 'msg' });
  const progressBar = el('div', { class: 'bar indeterminate' }, el('i'));

  async function launch(app, params) {
    current = { app, params };
    m.titleEl.textContent = `Launching ${app.name || app.id}`;
    clear(m.body);
    progressMsg.textContent = 'Submitting launch request…';
    progressBar.classList.add('indeterminate');
    m.body.appendChild(el('div', { class: 'progress' }, el('div', null, spinner(), ' ', progressMsg), progressBar));
    footer(el('span', { class: 'left' }, 'You can close this dialog; the launch continues on the server.'), cancelBtn('Close'));
    try {
      const res = await api.post(`/api/apps/${encodeURIComponent(app.id)}/launch`, params);
      jobId = res && res.jobId;
      if (!jobId) throw new Error('The server did not return a job id.');
      startPolling();
    } catch (err) {
      showFailure({ code: err.code, message: err.message, details: err.details });
    }
  }

  function updateProgress(progress) {
    if (!progress) return;
    progressMsg.textContent = progress.message || '';
    const determinate = Number(progress.total) > 0;
    progressBar.classList.toggle('indeterminate', !determinate);
    if (determinate) progressBar.firstElementChild.style.width = `${Math.min(100, Math.round((Number(progress.current) / Number(progress.total)) * 100))}%`;
  }

  function startPolling() {
    stopPolling();
    pollFailures = 0;
    pollTimer = setInterval(async () => {
      if (!jobId) return;
      try {
        applyJob(await api.get(`/api/jobs/${encodeURIComponent(jobId)}`));
        pollFailures = 0;
      } catch (err) {
        pollFailures += 1;
        if (err.status === 404 || pollFailures >= 8) showFailure({ code: err.code, message: `Lost track of the launch job: ${err.message}` });
      }
    }, 1000);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function applyJob(job) {
    if (!job || !jobId || job.id !== jobId) return;
    if (job.status === 'running') {
      updateProgress(job.progress);
      return;
    }
    stopPolling();
    jobId = null;
    if (job.status === 'done') showDone(job.result || {});
    else showFailure(job.error || { message: 'Launch failed' });
  }

  /* ---------- results ---------- */
  async function showDone(result) {
    const app = current ? current.app : null;
    m.titleEl.textContent = 'Container started';
    clear(m.body);
    const deps = Array.isArray(result.dependencies) ? result.dependencies : [];
    m.body.append(...[
      el('p', null, 'Started ', el('strong', { class: 'mono', text: result.name || '' }), result.id ? el('span', { class: 'dim mono' }, ` ${String(result.id).slice(0, 12)}`) : null),
      deps.length ? el('ul', { class: 'result-list' }, deps.map((d) => el('li', null, el('span', { class: 'mono' }, d.name || d.app), ` — ${d.action}`))) : null,
    ].filter(Boolean));
    const logsBtn = result.id ? el('button', { class: 'btn', type: 'button', onClick: () => openLogsPanel({ id: result.id, name: result.name || result.id }) }, 'Logs') : null;
    footer(logsBtn, cancelBtn('Done'));
    const url = await resolveWebUi(app, result);
    if (url) m.foot.insertBefore(el('a', { class: 'btn primary', href: url, target: '_blank', rel: 'noopener' }, 'Open UI'), m.foot.firstChild);
  }

  async function resolveWebUi(app, result) {
    if (result.id) {
      try {
        const { summary } = await api.get(containerPath(result.id));
        const url = webUiUrl(summary && summary.webUI);
        if (url) return url;
      } catch {
        /* fall through to the catalog defaults */
      }
    }
    if (!app || !app.webUI) return null;
    const key = `${app.webUI.containerPort}/tcp`;
    const fromParams = current && current.params.hostPorts ? current.params.hostPorts[key] : undefined;
    const fromCatalog = (app.ports || []).find((p) => p.containerPort === app.webUI.containerPort);
    const hostPort = fromParams ?? (fromCatalog ? fromCatalog.hostPort : null);
    return webUiUrl({ hostPort, path: app.webUI.path });
  }

  function showFailure(error) {
    stopPolling();
    jobId = null;
    const app = current ? current.app : null;
    m.titleEl.textContent = 'Launch failed';
    clear(m.body);
    m.body.appendChild(el('div', { class: 'error-box' }, error.message || 'Unknown error', error.code ? el('span', { class: 'dim mono' }, ` (${error.code})`) : null));
    const back = app ? el('button', { class: 'btn', type: 'button', onClick: () => showForm(app) }, 'Back to form') : null;
    const conflict = error.code === 'name_conflict' && error.details && error.details.id ? error.details : null;
    if (conflict && app) {
      m.body.appendChild(el('p', { class: 'muted' }, 'A container named ', el('span', { class: 'mono', text: conflict.name || '' }), ` already exists (${conflict.state || 'unknown state'}).`));
      footer(
        back,
        el('button', { class: 'btn', type: 'button', onClick: async () => {
          try {
            await api.post(containerPath(conflict.id, '/start'));
            toast(`Started ${conflict.name}`, { kind: 'success' });
            showDone({ id: conflict.id, name: conflict.name, dependencies: [] });
          } catch (err) {
            toastError(err, 'Start failed');
          }
        } }, 'Start existing'),
        el('button', { class: 'btn danger', type: 'button', onClick: async () => {
          try {
            await api.del(containerPath(conflict.id), { force: 1 });
            launch(app, current.params);
          } catch (err) {
            toastError(err, 'Remove failed');
          }
        } }, 'Remove & relaunch'),
        cancelBtn('Close'),
      );
      return;
    }
    footer(back, cancelBtn('Close'));
  }
}
