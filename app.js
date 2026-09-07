/* ==========================================================================
   InnPass · app.js
   PWA mínima: traduce la marca de la caja a DCI/INN y la enseña en un pase.

   Dos modos en la misma URL:
     - sin hash        → editor del paciente (pantallas 1 y 2)
     - con #p=...      → tarjeta del farmacéutico (pantalla 3), sin editor

   Formato del hash (compacto):  #p=amlodipine:5mg:tab,metformin:850mg:tab
     - cada campo pasa por encodeURIComponent; separadores ':' y ','
     - solo inn (inglés del catálogo) + dose + form. Las marcas NO viajan.
   Persistencia paciente: localStorage["innpass.meds.v1"] = [{inn,dose,form}]
   ========================================================================== */
(function () {
  'use strict';

  const CATALOG_URL = './drugs.json';
  const STORAGE_KEY = 'innpass.meds.v1';
  const DEFAULT_COUNTRY = 'ES';
  const MAX_RESULTS = 8;

  const FORM_LABELS = {
    tab: { es: 'comprimido', en: 'tablet' },
    cap: { es: 'cápsula', en: 'capsule' },
    inh: { es: 'inhalador', en: 'inhaler' },
    inj: { es: 'inyección', en: 'injection' },
  };

  const COUNTRY_NAMES = {
    ES: 'España', US: 'EE. UU.', FR: 'Francia', IT: 'Italia', DE: 'Alemania',
    PT: 'Portugal', GB: 'Reino Unido', MX: 'México',
  };

  // ------------------------------------------------------------------------
  // Estado
  // ------------------------------------------------------------------------
  const state = {
    drugs: [],              // catálogo (drugs.json → .drugs)
    byInn: new Map(),       // inn → fármaco
    countries: [],          // códigos de país presentes en brands
    meds: [],               // lista del paciente [{inn, dose, form}]
    current: null,          // fármaco abierto en la ficha
    sel: { dose: null, form: null },
    passItems: [],          // lo que se está pintando en el pase
    passUrl: '',
    country: DEFAULT_COUNTRY,
    activeResult: -1,
    results: [],
    installPrompt: null,
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    views: { home: $('view-home'), drug: $('view-drug'), pass: $('view-pass') },
    boot: $('boot'),
    searchInput: $('search-input'),
    searchClear: $('search-clear'),
    results: $('search-results'),
    searchEmpty: $('search-empty'),
    treatmentList: $('treatment-list'),
    treatmentEmpty: $('treatment-empty'),
    treatmentCount: $('treatment-count'),
    btnShowPass: $('btn-show-pass'),
    btnDrugBack: $('btn-drug-back'),
    drugInnEs: $('drug-inn-es'),
    drugInn: $('drug-inn'),
    drugAtc: $('drug-atc'),
    drugAlerts: $('drug-alerts'),
    drugDoses: $('drug-doses'),
    drugForms: $('drug-forms'),
    drugBrandsEs: $('drug-brands-es'),
    drugCtaHint: $('drug-cta-hint'),
    btnAdd: $('btn-add'),
    btnPassBack: $('btn-pass-back'),
    btnPassOwn: $('btn-pass-own'),
    countrySelect: $('country-select'),
    passList: $('pass-list'),
    passEmpty: $('pass-empty'),
    qr: $('qr'),
    btnCopy: $('btn-copy'),
    btnInstall: $('btn-install'),
    installDialog: $('install-dialog'),
    installSteps: $('install-steps'),
    installClose: $('install-close'),
    toast: $('toast'),
  };

  // ------------------------------------------------------------------------
  // Utilidades
  // ------------------------------------------------------------------------
  function norm(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function cap(s) {
    s = String(s || '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // "5mg" → "5 mg", "50ug" → "50 µg", "100IU/ml" → "100 IU/ml"
  function fmtDose(dose) {
    const m = /^([\d.,]+(?:\/[\d.,]+)?)\s*(.*)$/.exec(String(dose || ''));
    if (!m) return dose;
    const unit = m[2].replace(/^ug\b/, 'µg');
    return unit ? `${m[1]} ${unit}` : m[1];
  }

  function fmtForm(form, lang) {
    const f = FORM_LABELS[form];
    return f ? f[lang] : form;
  }

  function countryName(cc) {
    return COUNTRY_NAMES[cc] || cc;
  }

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function svgIcon(path) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', path);
    svg.append(p);
    return svg;
  }
  const WARN_PATH = 'M12 3 2.5 20h19L12 3zm0 6v5m0 3v.5';

  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
  }

  // ------------------------------------------------------------------------
  // Persistencia (solo en este móvil)
  // ------------------------------------------------------------------------
  function loadMeds() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((m) => m && typeof m.inn === 'string' && m.inn)
        .map((m) => ({ inn: m.inn, dose: String(m.dose || ''), form: String(m.form || '') }));
    } catch {
      return [];
    }
  }

  function saveMeds() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.meds));
    } catch {
      /* modo privado sin almacenamiento: la sesión sigue funcionando en memoria */
    }
  }

  // ------------------------------------------------------------------------
  // Hash  #p=inn:dose:form,inn:dose:form
  // ------------------------------------------------------------------------
  function encodePayload(items) {
    return items
      .map((i) => [i.inn, i.dose, i.form].map((x) => encodeURIComponent(x || '')).join(':'))
      .join(',');
  }

  function parseHash(hash) {
    const m = /^#p=(.+)$/.exec(hash || '');
    if (!m) return null;
    let raw = m[1];
    // Se decodifica la cadena completa: sirve tanto si se codificó campo a
    // campo (lo que hace la app) como si alguien codificó el payload entero.
    try { raw = decodeURIComponent(raw); } catch { /* se deja tal cual */ }
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [inn = '', dose = '', form = ''] = s.split(':');
        return { inn: inn.trim().toLowerCase(), dose: dose.trim(), form: form.trim().toLowerCase() };
      })
      .filter((i) => i.inn);
  }

  function buildPassUrl(items) {
    const url = new URL(location.href);
    url.hash = 'p=' + encodePayload(items);
    return url.href;
  }

  function sameItems(a, b) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => x.inn === b[i].inn && x.dose === b[i].dose && x.form === b[i].form);
  }

  function clearHash() {
    history.replaceState(null, '', location.pathname + location.search);
  }

  // ------------------------------------------------------------------------
  // Navegación entre vistas
  // ------------------------------------------------------------------------
  function showView(name) {
    for (const [k, v] of Object.entries(el.views)) v.hidden = k !== name;
    document.title = name === 'pass' ? 'InnPass · Pase DCI' : 'InnPass · Tu medicación en DCI';
    window.scrollTo(0, 0);
  }

  function route() {
    const items = parseHash(location.hash);
    if (items && items.length) {
      renderPass(items);
      showView('pass');
    } else {
      renderTreatment();
      showView('home');
    }
  }

  // ------------------------------------------------------------------------
  // Buscador / autocomplete
  // ------------------------------------------------------------------------
  // Índice: por fármaco, tokens {text, kind, label, countries}
  function buildIndex() {
    const countries = new Set();
    for (const d of state.drugs) {
      state.byInn.set(d.inn, d);
      const tokens = [
        { text: norm(d.inn), kind: 'inn', label: d.inn },
        { text: norm(d.inn_es), kind: 'inn_es', label: d.inn_es },
        { text: norm(d.atc), kind: 'atc', label: d.atc },
      ];
      const brandMap = new Map();
      for (const [cc, list] of Object.entries(d.brands || {})) {
        countries.add(cc);
        for (const b of list || []) {
          const key = norm(b);
          if (!brandMap.has(key)) brandMap.set(key, { text: key, kind: 'brand', label: b, countries: [] });
          brandMap.get(key).countries.push(cc);
        }
      }
      d._tokens = tokens.concat([...brandMap.values()]);
    }
    state.countries = [...countries].sort((a, b) => (a === 'ES' ? -1 : b === 'ES' ? 1 : a.localeCompare(b)));
  }

  function search(query) {
    const q = norm(query);
    if (q.length < 2) return [];
    const out = [];
    for (const d of state.drugs) {
      let best = null;
      for (const t of d._tokens) {
        let score = 0;
        if (t.text === q) score = 4;
        else if (t.text.startsWith(q)) score = 3;
        else if (t.text.includes(' ' + q)) score = 2;
        else if (t.text.includes(q)) score = 1;
        if (!score) continue;
        // preferimos DCI sobre marca en empate
        if (t.kind === 'inn_es' || t.kind === 'inn') score += 0.5;
        if (!best || score > best.score) best = { score, token: t };
      }
      if (best) out.push({ drug: d, token: best.token, score: best.score });
    }
    out.sort((a, b) => b.score - a.score || a.drug.inn_es.localeCompare(b.drug.inn_es));
    return out.slice(0, MAX_RESULTS);
  }

  function highlight(label, query) {
    const q = norm(query);
    const idx = norm(label).indexOf(q);
    if (idx < 0 || !q) return [label];
    return [label.slice(0, idx), h('mark', null, label.slice(idx, idx + q.length)), label.slice(idx + q.length)];
  }

  function renderResults(query) {
    const results = search(query);
    state.results = results;
    state.activeResult = -1;
    el.results.replaceChildren();
    const has = results.length > 0;
    el.results.hidden = !has;
    el.searchEmpty.hidden = has || norm(query).length < 2;
    el.searchInput.setAttribute('aria-expanded', String(has));

    results.forEach((r, i) => {
      const d = r.drug;
      const t = r.token;
      let title, sub, tag, tagClass = '';
      if (t.kind === 'brand') {
        title = highlight(t.label, query);
        sub = `→ ${cap(d.inn_es)} · ${d.inn}`;
        tag = `marca · ${t.countries.join(', ')}`;
        tagClass = 'brand';
      } else if (t.kind === 'atc') {
        title = [cap(d.inn_es)];
        sub = `ATC ${d.atc} · ${d.inn}`;
        tag = 'ATC';
      } else {
        title = highlight(cap(d.inn_es), query);
        const es = (d.brands && d.brands.ES) || [];
        sub = d.inn + (es.length ? ` · ES: ${es.join(', ')}` : '');
        tag = 'DCI';
      }
      const li = h('li', { role: 'option', id: `result-${i}`, 'aria-selected': 'false' },
        h('div', { class: 'r-title' }, ...title),
        h('span', { class: `r-tag ${tagClass}`, text: tag }),
        h('div', { class: 'r-sub', text: sub }));
      li.addEventListener('pointerdown', (e) => e.preventDefault()); // no perder el foco del input
      li.addEventListener('click', () => openDrug(d));
      el.results.append(li);
    });
  }

  function setActiveResult(i) {
    const items = el.results.children;
    if (!items.length) return;
    state.activeResult = (i + items.length) % items.length;
    for (let k = 0; k < items.length; k++) {
      items[k].setAttribute('aria-selected', String(k === state.activeResult));
    }
    items[state.activeResult].scrollIntoView({ block: 'nearest' });
    el.searchInput.setAttribute('aria-activedescendant', items[state.activeResult].id);
  }

  function closeResults() {
    el.results.hidden = true;
    el.searchEmpty.hidden = true;
    el.searchInput.setAttribute('aria-expanded', 'false');
    el.searchInput.removeAttribute('aria-activedescendant');
  }

  function resetSearch() {
    el.searchInput.value = '';
    el.searchClear.hidden = true;
    closeResults();
  }

  el.searchInput.addEventListener('input', () => {
    el.searchClear.hidden = !el.searchInput.value;
    renderResults(el.searchInput.value);
  });
  el.searchInput.addEventListener('focus', () => {
    if (el.searchInput.value) renderResults(el.searchInput.value);
  });
  el.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveResult(state.activeResult + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveResult(state.activeResult - 1); }
    else if (e.key === 'Enter') {
      const i = state.activeResult >= 0 ? state.activeResult : 0;
      if (state.results[i]) { e.preventDefault(); openDrug(state.results[i].drug); }
    } else if (e.key === 'Escape') { closeResults(); }
  });
  el.searchClear.addEventListener('click', () => { resetSearch(); el.searchInput.focus(); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search')) closeResults();
  });

  // ------------------------------------------------------------------------
  // Pantalla 1 · Tu tratamiento
  // ------------------------------------------------------------------------
  function renderTreatment() {
    el.treatmentList.replaceChildren();
    const n = state.meds.length;
    el.treatmentEmpty.hidden = n > 0;
    el.treatmentCount.hidden = n === 0;
    el.treatmentCount.textContent = n === 1 ? '1 fármaco' : `${n} fármacos`;
    el.btnShowPass.disabled = n === 0;

    state.meds.forEach((m, i) => {
      const d = state.byInn.get(m.inn);
      const title = d ? d.inn_es : m.inn;
      const sub = [d ? d.inn : null, fmtDose(m.dose), fmtForm(m.form, 'es')].filter(Boolean).join(' · ');
      el.treatmentList.append(
        h('li', null,
          h('div', { class: 'm-main' },
            h('div', { class: 'm-title', text: title }),
            h('div', { class: 'm-sub', text: sub })),
          h('button', {
            class: 'm-remove', type: 'button', 'aria-label': `Quitar ${title}`,
            onclick: () => removeMed(i),
          }, '×')));
    });
  }

  function removeMed(i) {
    const [removed] = state.meds.splice(i, 1);
    saveMeds();
    renderTreatment();
    if (removed) {
      const d = state.byInn.get(removed.inn);
      toast(`Quitado: ${cap(d ? d.inn_es : removed.inn)}`);
    }
  }

  el.btnShowPass.addEventListener('click', () => {
    if (!state.meds.length) return;
    // Cambiar el hash dispara route() → pase. La URL ya es compartible.
    location.hash = 'p=' + encodePayload(state.meds);
  });

  // ------------------------------------------------------------------------
  // Pantalla 2 · Ficha del fármaco
  // ------------------------------------------------------------------------
  function openDrug(drug) {
    state.current = drug;
    state.sel = {
      dose: drug.doses.length === 1 ? drug.doses[0] : null,
      form: drug.forms.length === 1 ? drug.forms[0] : null,
    };
    el.drugInnEs.textContent = drug.inn_es;
    el.drugInn.textContent = drug.inn;
    el.drugAtc.textContent = drug.atc ? `ATC ${drug.atc}` : '';

    el.drugAlerts.replaceChildren();
    const alerts = drug.alerts || [];
    el.drugAlerts.hidden = alerts.length === 0;
    for (const a of alerts) {
      el.drugAlerts.append(h('div', { class: 'alert', role: 'note' }, svgIcon(WARN_PATH), h('span', { text: a })));
    }

    const es = (drug.brands && drug.brands.ES) || [];
    el.drugBrandsEs.textContent = es.length ? `En España se vende como: ${es.join(', ')}.` : '';

    renderPills();
    closeResults();
    showView('drug');
  }

  function renderPills() {
    const d = state.current;
    const makePills = (container, values, key) => {
      container.replaceChildren();
      for (const v of values) {
        const checked = state.sel[key] === v;
        container.append(h('button', {
          class: 'pill', type: 'button', role: 'radio', 'aria-checked': String(checked),
          text: key === 'dose' ? fmtDose(v) : `${fmtForm(v, 'es')} · ${v}`,
          onclick: () => { state.sel[key] = v; renderPills(); },
        }));
      }
    };
    makePills(el.drugDoses, d.doses || [], 'dose');
    makePills(el.drugForms, d.forms || [], 'form');
    const ready = Boolean(state.sel.dose && state.sel.form);
    el.btnAdd.disabled = !ready;
    el.drugCtaHint.hidden = ready;
    el.drugCtaHint.textContent = !state.sel.dose ? 'Elige la dosis de tu caja' : 'Elige la forma';
  }

  el.btnAdd.addEventListener('click', () => {
    const d = state.current;
    if (!d || !state.sel.dose || !state.sel.form) return;
    const item = { inn: d.inn, dose: state.sel.dose, form: state.sel.form };
    const dup = state.meds.some((m) => m.inn === item.inn && m.dose === item.dose && m.form === item.form);
    if (!dup) {
      state.meds.push(item);
      saveMeds();
      toast(`Añadido: ${cap(d.inn_es)} ${fmtDose(item.dose)}`);
    } else {
      toast('Ya estaba en tu pase');
    }
    resetSearch();
    renderTreatment();
    showView('home');
  });

  el.btnDrugBack.addEventListener('click', () => {
    showView('home');
    el.searchInput.focus();
  });

  // ------------------------------------------------------------------------
  // Pantalla 3 · Pase / vista farmacéutico
  // ------------------------------------------------------------------------
  function renderCountrySelect() {
    el.countrySelect.replaceChildren();
    for (const cc of state.countries) {
      el.countrySelect.append(h('option', { value: cc, text: `${cc} · ${countryName(cc)}` }));
    }
    el.countrySelect.value = state.countries.includes(state.country) ? state.country : state.countries[0];
    state.country = el.countrySelect.value;
  }

  function renderPassList() {
    el.passList.replaceChildren();
    const items = state.passItems;
    el.passEmpty.hidden = items.length > 0;
    for (const it of items) {
      const d = state.byInn.get(it.inn);
      const li = h('li');
      if (d) {
        li.append(h('div', { class: 'p-inn-es', text: d.inn_es }));
        li.append(h('div', { class: 'p-line' },
          h('span', { class: 'p-inn', text: d.inn }),
          it.dose ? [h('span', { class: 'p-sep' }, '·'), h('span', { text: fmtDose(it.dose) })] : null,
          it.form ? [h('span', { class: 'p-sep' }, '·'), h('span', { text: fmtForm(it.form, 'en') })] : null));
        const brands = (d.brands && d.brands[state.country]) || [];
        li.append(h('div', { class: 'p-brands' },
          brands.length
            ? [h('b', { text: `Marcas ${state.country}: ` }), brands.join(' · ')]
            : `Sin marca registrada en el catálogo para ${countryName(state.country)}`));
        for (const a of d.alerts || []) {
          li.append(h('div', { class: 'p-alert' }, svgIcon(WARN_PATH), h('span', { text: a })));
        }
      } else {
        // inn desconocido para este catálogo: se muestra tal cual, sin inventar nada
        li.append(h('div', { class: 'p-inn-es unknown', text: it.inn }));
        li.append(h('div', { class: 'p-line' },
          it.dose ? h('span', { text: fmtDose(it.dose) }) : null,
          it.form ? [h('span', { class: 'p-sep' }, '·'), h('span', { text: fmtForm(it.form, 'en') })] : null));
        li.append(h('div', { class: 'p-brands', text: 'No está en el catálogo del piloto.' }));
      }
      el.passList.append(li);
    }
  }

  function renderQr(url) {
    el.qr.replaceChildren();
    try {
      if (typeof qrcode !== 'function') throw new Error('qrcode lib no disponible');
      const qr = qrcode(0, 'M'); // 0 = tamaño automático
      qr.addData(url);
      qr.make();
      el.qr.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch {
      // Fallback: API pública (solo si la librería local falla; requiere red)
      const img = h('img', {
        alt: 'Código QR del pase',
        src: 'https://api.qrserver.com/v1/create-qr-code/?size=480x480&margin=8&data=' + encodeURIComponent(url),
      });
      el.qr.append(img);
    }
  }

  function renderPass(items) {
    state.passItems = items;
    state.passUrl = buildPassUrl(items);
    if (!el.countrySelect.options.length) renderCountrySelect();
    renderPassList();
    renderQr(state.passUrl);

    // ¿Es el pase del propio paciente (mismo contenido que su lista)? → "Editar"
    const own = sameItems(items, state.meds);
    el.btnPassBack.hidden = !own;
    el.btnPassOwn.hidden = own;
  }

  el.countrySelect.addEventListener('change', () => {
    state.country = el.countrySelect.value;
    renderPassList();
  });

  function backToEditor() {
    clearHash();
    route();
  }
  el.btnPassBack.addEventListener('click', backToEditor);
  el.btnPassOwn.addEventListener('click', backToEditor);

  // Copia con degradación: Clipboard API → execCommand → Web Share → prompt
  function legacyCopy(text) {
    const ta = h('textarea', { readonly: true, 'aria-hidden': 'true' });
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.append(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  el.btnCopy.addEventListener('click', async () => {
    const url = state.passUrl;
    try {
      if (!navigator.clipboard) throw new Error('sin Clipboard API');
      await navigator.clipboard.writeText(url);
      toast('Enlace copiado');
      return;
    } catch { /* seguimos con el siguiente método */ }
    if (legacyCopy(url)) { toast('Enlace copiado'); return; }
    if (navigator.share) {
      try { await navigator.share({ title: 'InnPass', url }); return; } catch { /* cancelado */ }
    }
    window.prompt('Copia este enlace:', url);
  });

  // ------------------------------------------------------------------------
  // Instalación (Añadir a inicio)
  // ------------------------------------------------------------------------
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
  });

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function installSteps() {
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);
    const frag = document.createDocumentFragment();
    const block = (title, steps) => {
      frag.append(h('h3', { text: title }), h('ol', null, ...steps.map((s) => h('li', { text: s }))));
    };
    if (isIOS) {
      block('iPhone / iPad (Safari)', [
        'Toca el botón Compartir (cuadrado con flecha hacia arriba).',
        'Elige "Añadir a pantalla de inicio".',
        'Confirma con "Añadir".',
      ]);
    } else if (isAndroid) {
      block('Android (Chrome)', [
        'Abre el menú ⋮ arriba a la derecha.',
        'Elige "Instalar aplicación" o "Añadir a pantalla de inicio".',
        'Confirma.',
      ]);
    } else {
      block('Ordenador (Chrome / Edge)', [
        'Pulsa el icono de instalar en la barra de direcciones.',
        'O abre el menú ⋮ → "Instalar InnPass".',
      ]);
      block('iPhone / Android', ['Abre este mismo enlace en el móvil y usa "Añadir a pantalla de inicio".']);
    }
    return frag;
  }

  el.btnInstall.addEventListener('click', async () => {
    if (isStandalone()) { toast('InnPass ya está instalada'); return; }
    if (state.installPrompt) {
      const p = state.installPrompt;
      state.installPrompt = null;
      p.prompt();
      try { await p.userChoice; } catch { /* ignorar */ }
      return;
    }
    el.installSteps.replaceChildren(installSteps());
    if (typeof el.installDialog.showModal === 'function') el.installDialog.showModal();
    else el.installDialog.setAttribute('open', '');
  });
  el.installClose.addEventListener('click', () => el.installDialog.close());
  el.installDialog.addEventListener('click', (e) => { if (e.target === el.installDialog) el.installDialog.close(); });

  // ------------------------------------------------------------------------
  // Arranque
  // ------------------------------------------------------------------------
  async function boot() {
    try {
      const res = await fetch(CATALOG_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.drugs = Array.isArray(data) ? data : (data.drugs || []);
      if (!state.drugs.length) throw new Error('catálogo vacío');
    } catch (err) {
      el.boot.classList.add('error');
      el.boot.replaceChildren(
        h('div', null,
          h('p', null, h('strong', { text: 'No se pudo cargar drugs.json.' })),
          h('p', { class: 'small' }, 'Abre la app desde un servidor local, no desde file://'),
          h('p', { class: 'small' }, h('code', { text: 'python3 -m http.server 5173' })),
          h('p', { class: 'small muted', text: String(err && err.message || err) })));
      return;
    }
    buildIndex();
    state.meds = loadMeds();
    renderCountrySelect();
    route();
    el.boot.hidden = true;
  }

  window.addEventListener('hashchange', route);

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* sin SW seguimos funcionando online */ });
    });
  }

  boot();
})();
