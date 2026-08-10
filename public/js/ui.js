/* Tiny shared helpers: DOM lookup, toasts, clipboard, fetch-with-JSON. */

(function (global) {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function rail() {
    let el = document.querySelector('.toast-rail');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast-rail';
      document.body.appendChild(el);
    }
    return el;
  }

  function toast(message, kind = '') {
    const el = document.createElement('div');
    el.className = `toast${kind ? ` toast--${kind}` : ''}`;
    el.textContent = message;
    rail().appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 320);
    }, 3200);
  }

  async function copy(text, label = 'Tersalin ke clipboard') {
    try {
      await navigator.clipboard.writeText(text);
      toast(label, 'good');
      return true;
    } catch {
      // Clipboard API needs a secure context; fall back to the old trick.
      const input = document.createElement('textarea');
      input.value = text;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      const ok = document.execCommand('copy');
      input.remove();
      toast(ok ? label : 'Gagal menyalin — salin manual ya.', ok ? 'good' : 'bad');
      return ok;
    }
  }

  async function api(url, options = {}) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
    return data;
  }

  /** Stable per-browser id so anonymous viewers keep their strokes across reloads. */
  function anonId() {
    const KEY = 'dil.anonId';
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/-/g, '').slice(0, 24);
      localStorage.setItem(KEY, id);
    }
    return id;
  }

  function wireCopyButtons(root = document) {
    $$('[data-copy]', root).forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = document.querySelector(btn.dataset.copy);
        if (target) copy(target.value || target.textContent, btn.dataset.copyLabel || 'Tersalin ke clipboard');
      });
    });
  }

  global.UI = { $, $$, toast, copy, api, anonId, wireCopyButtons };
})(window);
