// Small DOM toolkit: element builder, icons, toasts, context menus, modal forms.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv);
    } else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}

// replaceChildren that ignores null/false and flattens arrays.
export function put(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
}

const P = (d) => `<path d="${d}"/>`;
const C = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}"/>`;
const ICONS = {
  folder: P('M1.5 4.5v8h13v-7h-6l-1.5-2h-5.5z'),
  plus: P('M8 3v10M3 8h10'),
  minus: P('M3 8h10'),
  close: P('M4 4l8 8M12 4l-8 8'),
  chevDown: P('M4 6l4 4 4-4'),
  chevRight: P('M6 4l4 4-4 4'),
  chevLeft: P('M10 4L6 8l4 4'),
  undo: P('M4 7h5.5a3.5 3.5 0 010 7H7M4 7l3-3M4 7l3 3'),
  redo: P('M12 7H6.5a3.5 3.5 0 000 7H9M12 7l-3-3M12 7l-3 3'),
  pull: P('M8 2v8M4.5 6.5L8 10l3.5-3.5M3 13.5h10'),
  push: P('M8 14V6M4.5 9.5L8 6l3.5 3.5M3 2.5h10'),
  branch: P('M5 5.5v5M5 10.5c0-3 6-1.5 6-5') + C(5, 4, 1.5) + C(5, 12, 1.5) + C(11, 4, 1.5),
  stash: P('M2.5 9.5v4h11v-4M8 2v7.5M5 6.5l3 3 3-3'),
  pop: P('M2.5 9.5v4h11v-4M8 9.5V2M5 5l3-3 3 3'),
  terminal: P('M2.5 4l4 4-4 4M8 12.5h5.5'),
  search: C(7, 7, 4.5) + P('M10.5 10.5L14 14'),
  gear: C(8, 8, 2.2) + C(8, 8, 4.6) + P('M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2M3.3 3.3l1.5 1.5M11.2 11.2l1.5 1.5M3.3 12.7l1.5-1.5M11.2 4.8l1.5-1.5'),
  laptop: P('M3 4h10v6.5H3zM1.5 12.5h13'),
  cloud: P('M4.5 12.5a3 3 0 01-.4-6 4 4 0 017.7 1 2.6 2.6 0 01-.3 5z'),
  globe: C(8, 8, 5.5) + P('M2.5 8h11M8 2.5c-2.6 2-2.6 9 0 11M8 2.5c2.6 2 2.6 9 0 11'),
  tag: P('M2 2.5h5.5l6.5 6.5-5 5L2.5 7.5zM5 5.2h.01'),
  trash: P('M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.5 9h6l.5-9M6.8 7v4M9.2 7v4'),
  pencil: P('M2.5 13.5l.7-3L10.5 3l2.5 2.5-7.5 7.3z'),
  check: P('M3 8.5l3.5 3.5L13 4.5'),
  commit: C(8, 8, 2.5) + P('M1 8h4.5M10.5 8H15'),
  copy: P('M5.5 5.5h8v8h-8zM2.5 10.5v-8h8'),
  refresh: P('M13 8a5 5 0 11-1.5-3.5M13 2.5v3h-3'),
  list: P('M2.5 4h11M2.5 8h11M2.5 12h11'),
  tree: P('M2.5 3h4M5 3v9h3M5 7.5h3M9.5 6.5h4v2h-4zM9.5 11h4v2h-4z'),
  box: P('M2 4h12v3H2zM3 7v6.5h10V7M6.5 10h3'),
  warn: P('M8 2l6.5 11.5h-13zM8 6.5v3.5M8 12h.01'),
  user: C(8, 5.5, 2.5) + P('M3 13.5c.5-3 2.5-4 5-4s4.5 1 5 4'),
  arrowRight: P('M3 8h10M9.5 4.5L13 8l-3.5 3.5'),
  update: C(8, 8, 6) + P('M8 11.2V5.2M5.4 7.7L8 5.1l2.6 2.6'),
};

export function icon(name, size = 16, cls = '') {
  const s = document.createElement('span');
  s.className = 'ico ' + cls;
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return s;
}

// ---- toasts ----
export function toast(text, { spin = false, ms = 3500 } = {}) {
  const box = document.getElementById('toasts');
  const body = h('div', { class: 'ttext' }, text);
  const el = h('div', { class: 'toast' + (spin ? ' spin' : '') }, h('span', { class: 'spinner' }), body);
  box.append(el);
  let timer = spin ? null : setTimeout(() => el.remove(), ms);
  const api = {
    done(msg) {
      el.classList.remove('spin');
      el.classList.add('ok');
      body.textContent = msg;
      clearTimeout(timer);
      timer = setTimeout(() => el.remove(), 2500);
    },
    error(title, detail) {
      el.classList.remove('spin');
      el.classList.add('err');
      body.replaceChildren(
        h('div', { class: 'ttitle' }, title),
        detail ? h('pre', {}, detail) : null,
        h('button', { class: 'tclose', onclick: () => el.remove() }, icon('close', 12))
      );
      clearTimeout(timer);
      timer = setTimeout(() => el.remove(), 30000);
    },
    close() {
      clearTimeout(timer);
      el.remove();
    },
  };
  return api;
}

// ---- context menu ----
let openMenu = null;
export function closeMenu() {
  if (openMenu) openMenu.remove();
  openMenu = null;
}
export function menu(x, y, items, { minWidth } = {}) {
  closeMenu();
  const el = h('div', { class: 'menu', style: minWidth ? { minWidth: minWidth + 'px' } : null });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') el.append(h('div', { class: 'msep' }));
    else if (it.header) el.append(h('div', { class: 'mhead' }, it.header));
    else
      el.append(
        h(
          'div',
          {
            class: 'mitem' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : ''),
            onclick: (e) => {
              e.stopPropagation();
              if (it.disabled) return;
              closeMenu();
              it.action && it.action();
            },
          },
          h('span', { class: 'mcheck' }, it.check ? icon('check', 12) : it.icon ? icon(it.icon, 13) : null),
          h('span', { class: 'mlabel' }, it.label),
          it.hint ? h('span', { class: 'mhint' }, it.hint) : null
        )
      );
  }
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + 'px';
  el.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + 'px';
  openMenu = el;
  return el;
}
export function menuAt(anchor, items, opts = {}) {
  const r = anchor.getBoundingClientRect();
  return menu(opts.right ? r.right - (opts.minWidth || 200) : r.left, r.bottom + 4, items, opts);
}
addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});
addEventListener('blur', closeMenu);

// ---- modal form ----
// fields: {name, label, value, placeholder, type: text|checkbox|select|number, options:[{value,label}], hint}
export function form({ title, message, detail, fields = [], ok = 'OK', danger = false, cancel = 'Cancel' }) {
  return new Promise((resolve) => {
    const inputs = {};
    const rows = fields.map((f) => {
      let input;
      if (f.type === 'checkbox') {
        input = h('input', { type: 'checkbox', checked: !!f.value });
        inputs[f.name] = input;
        return h('label', { class: 'frow check' }, input, h('span', {}, f.label));
      }
      if (f.type === 'image') {
        // A small square picture, stored as a data URL.
        let val = f.value || '';
        const prev = h('span', { class: 'imgprev' });
        const file = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
        const clear = h('button', { class: 'btn', type: 'button', onclick: (e) => (e.preventDefault(), (val = ''), draw()) }, 'Remove');
        const draw = () => {
          put(prev, val ? h('img', { src: val }) : null);
          clear.hidden = !val;
        };
        file.addEventListener('change', () => {
          const fl = file.files[0];
          if (!fl) return;
          const rd = new FileReader();
          rd.onload = () => {
            const img = new Image();
            img.onload = () => {
              const c = document.createElement('canvas');
              c.width = c.height = 96;
              const side = Math.min(img.width, img.height);
              c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 96, 96);
              val = c.toDataURL('image/png');
              draw();
            };
            img.src = rd.result;
          };
          rd.readAsDataURL(fl);
          file.value = '';
        });
        draw();
        inputs[f.name] = { get value() { return val; }, focus() {} };
        return h('div', { class: 'frow' }, h('span', { class: 'flabel' }, f.label), h('div', { class: 'imgrow' }, prev, h('button', { class: 'btn', type: 'button', onclick: (e) => (e.preventDefault(), file.click()) }, 'Choose image…'), clear, file));
      }
      if (f.type === 'select') {
        input = h(
          'select',
          {},
          f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label))
        );
      } else {
        input = h('input', {
          type: f.type || 'text',
          value: f.value ?? '',
          placeholder: f.placeholder || '',
          spellcheck: 'false',
          autocomplete: 'off',
        });
      }
      inputs[f.name] = input;
      return h('label', { class: 'frow' }, h('span', { class: 'flabel' }, f.label), input, f.hint ? h('span', { class: 'fhint' }, f.hint) : null);
    });
    const close = (val) => {
      back.remove();
      removeEventListener('keydown', onKey, true);
      resolve(val);
    };
    const submit = () => {
      const out = {};
      for (const f of fields) {
        const el = inputs[f.name];
        out[f.name] = f.type === 'checkbox' ? el.checked : el.value.trim();
        if (f.required && !out[f.name]) return el.focus();
      }
      close(out);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        submit();
      }
    };
    const okBtn = h('button', { class: 'btn ' + (danger ? 'red' : 'primary'), onclick: submit }, ok);
    const back = h(
      'div',
      { class: 'modal-back', onmousedown: (e) => e.target === back && close(null) },
      h(
        'div',
        { class: 'modal' },
        h('div', { class: 'mtitle' }, title),
        message ? h('div', { class: 'mmsg' }, message) : null,
        detail ? h('pre', { class: 'mdetail' }, detail) : null,
        rows,
        h('div', { class: 'mbtns' }, h('button', { class: 'btn', onclick: () => close(null) }, cancel), okBtn)
      )
    );
    document.body.append(back);
    addEventListener('keydown', onKey, true);
    const first = fields.find((f) => f.type !== 'checkbox' && f.type !== 'select' && f.type !== 'image');
    if (first) {
      inputs[first.name].focus();
      inputs[first.name].select?.();
    } else okBtn.focus();
  });
}

export const confirmBox = (title, message, ok = 'OK', danger = false, detail) =>
  form({ title, message, detail, ok, danger }).then((v) => v !== null);

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
