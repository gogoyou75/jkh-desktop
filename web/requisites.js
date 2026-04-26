// requisites.js — Реквизиты + подписанты (explicit /api/store persist + verify)

(function () {
  const KEY_REQ = 'organization_requisites_v1';
  const KEY_SIGNERS = 'organization_signers_v1';

  const reqDefaults = {
    full_name: '',
    short_name: '',
    form: 'ТСЖ',
    inn: '',
    ogrn: '',
    legal_address: '',
    postal_address: '',
    phone: '',
    email: ''
  };

  function makeId() {
    return 's_' + Math.random().toString(36).slice(2, 10);
  }

  const signerDefaults = [
    { id: makeId(), fio: '', position: 'Председатель правления', basis: '', is_default: true, active: true }
  ];

  function safeJsonParse(raw, fallback) {
    try { return JSON.parse(raw); } catch { return fallback; }
  }

  function getOwnerId() {
    try {
      if (window.JKHStore && typeof JKHStore.getOwnerId === 'function') {
        return JKHStore.getOwnerId() || '';
      }
    } catch (e) {}
    return '';
  }

  function storeGet(key, ownerId) {
    try { return (window.JKHStore && typeof JKHStore.getRaw === 'function') ? JKHStore.getRaw(key, ownerId) : null; } catch { return null; }
  }
  function storeSet(key, value, ownerId) {
    try { if (window.JKHStore && typeof JKHStore.setRaw === 'function') JKHStore.setRaw(key, value, ownerId); } catch {}
  }
  function storeRemove(key, ownerId) {
    try { if (window.JKHStore && typeof JKHStore.removeRaw === 'function') JKHStore.removeRaw(key, ownerId); } catch {}
  }

  function loadReq(ownerId) {
    const raw = storeGet(KEY_REQ, ownerId);
    if (!raw) return { ...reqDefaults };
    const obj = safeJsonParse(raw, null);
    return { ...reqDefaults, ...(obj || {}) };
  }

  function loadSigners(ownerId) {
    const raw = storeGet(KEY_SIGNERS, ownerId);
    if (!raw) return JSON.parse(JSON.stringify(signerDefaults));
    const arr = safeJsonParse(raw, null);
    const list = Array.isArray(arr) ? arr : [];
    const norm = list.map(s => ({
      id: s.id || makeId(),
      fio: (s.fio || '').trim(),
      position: (s.position || '').trim(),
      basis: (s.basis || '').trim(),
      is_default: !!s.is_default,
      active: s.active !== false
    }));
    if (!norm.some(s => s.is_default)) {
      if (norm[0]) norm[0].is_default = true;
    }
    return norm.length ? norm : JSON.parse(JSON.stringify(signerDefaults));
  }

  function normalizeSigners(list) {
    let cleaned = (list || []).filter(s =>
      (s.fio && s.fio.trim() !== '') ||
      (s.position && s.position.trim() !== '') ||
      (s.basis && s.basis.trim() !== '')
    );

    if (!cleaned.length) cleaned = JSON.parse(JSON.stringify(signerDefaults));

    let found = false;
    cleaned = cleaned.map(s => {
      const x = { ...s };
      if (x.is_default && !found) { found = true; x.is_default = true; }
      else x.is_default = false;
      x.active = x.active !== false;
      return x;
    });
    if (!found && cleaned[0]) cleaned[0].is_default = true;

    return cleaned;
  }

  async function apiPostStore(ownerId, key, value) {
    const res = await fetch('/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: ownerId, key, value })
    });

    let data = null;
    try { data = await res.json(); } catch (e) {}

    const success = res.ok && isApiOk(data);
    const status = res.status + (success ? '/ok' : '/fail');
    console.log('[requisites][api-store] key=' + key + ' status=' + status);

    if (!success) {
      throw new Error((data && (data.error || data.message)) ? (data.error || data.message) : ('HTTP ' + res.status + ' key=' + key));
    }
    return data;
  }

  function isApiOk(data) {
    return !!data && (data.ok === true || data.status === 'ok');
  }

  async function apiGetStore(ownerId, key) {
    try {
      const url = '/api/store?owner=' + encodeURIComponent(ownerId) + '&key=' + encodeURIComponent(key);
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) return { available: false, ok: false, value: null };
      const data = await res.json();
      if (!data) return { available: false, ok: false, value: null };
      return { available: true, ok: isApiOk(data), value: data.value || '' };
    } catch (e) {
      return { available: false, ok: false, value: null };
    }
  }

  async function verifySaved(ownerId) {
    const localReq = storeGet(KEY_REQ, ownerId);
    const localSigners = storeGet(KEY_SIGNERS, ownerId);

    const localReqOk = !!localReq;
    const localSignersOk = !!localSigners;

    const srvReq = await apiGetStore(ownerId, KEY_REQ);
    const srvSigners = await apiGetStore(ownerId, KEY_SIGNERS);

    const reqOk = localReqOk && (!srvReq.available || (srvReq.ok && !!srvReq.value));
    const signersOk = localSignersOk && (!srvSigners.available || (srvSigners.ok && !!srvSigners.value));

    console.log('[requisites][verify] requisites ' + (reqOk ? 'ok' : 'fail'));
    console.log('[requisites][verify] signers ' + (signersOk ? 'ok' : 'fail'));

    if (!reqOk || !signersOk) {
      throw new Error('Контроль сохранения не пройден');
    }
  }

  async function verifyCleared(ownerId) {
    const localReq = storeGet(KEY_REQ, ownerId);
    const localSigners = storeGet(KEY_SIGNERS, ownerId);

    const localReqOk = !localReq;
    const localSignersOk = !localSigners;

    const srvReq = await apiGetStore(ownerId, KEY_REQ);
    const srvSigners = await apiGetStore(ownerId, KEY_SIGNERS);

    const reqOk = localReqOk && (!srvReq.available || !srvReq.value);
    const signersOk = localSignersOk && (!srvSigners.available || !srvSigners.value);

    console.log('[requisites][verify] requisites ' + (reqOk ? 'ok' : 'fail'));
    console.log('[requisites][verify] signers ' + (signersOk ? 'ok' : 'fail'));

    if (!reqOk || !signersOk) {
      throw new Error('Контроль очистки не пройден');
    }
  }

  async function uploadOwnerDataOptional() {
    try {
      if (window.JKHRemoteSync && typeof window.JKHRemoteSync.uploadNow === 'function') {
        const ok = await window.JKHRemoteSync.uploadNow();
        if (ok === false) throw new Error('JKHRemoteSync.uploadNow returned false');
        console.log('[requisites][upload] success');
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[requisites][upload] warning', e);
      return false;
    }
  }

  async function waitForStoreReady(timeoutMs) {
    const started = Date.now();
    const waitStep = 100;
    while ((Date.now() - started) < timeoutMs) {
      const hasStore = !!(window.JKHStore && typeof JKHStore.getRaw === 'function');
      const uiStatus = String((window.JKH_UI_STATE && window.JKH_UI_STATE.data && window.JKH_UI_STATE.data.status) || '');
      const readyByUI = (uiStatus === 'ready' || uiStatus === 'empty');
      const readyByLegacy = (window.JKH_DATA_READY === true);

      if (hasStore && (readyByUI || readyByLegacy)) return true;
      await new Promise(r => setTimeout(r, waitStep));
    }
    return false;
  }

  function el(id) { return document.getElementById(id); }

  function setToast(msg, type) {
    const t = el('toast');
    if (!t) return;
    t.className = 'toast ' + (type || '');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(setToast._tm);
    setToast._tm = setTimeout(() => { t.style.display = 'none'; }, 2800);
  }

  function fillReqForm(data) {
    el('full_name').value = data.full_name || '';
    el('short_name').value = data.short_name || '';
    el('form').value = data.form || 'ТСЖ';
    el('inn').value = data.inn || '';
    el('ogrn').value = data.ogrn || '';
    el('legal_address').value = data.legal_address || '';
    el('postal_address').value = data.postal_address || '';
    el('phone').value = data.phone || '';
    el('email').value = data.email || '';
  }

  function readReqForm() {
    return {
      full_name: (el('full_name').value || '').trim(),
      short_name: (el('short_name').value || '').trim(),
      form: (el('form').value || 'ТСЖ').trim(),
      inn: (el('inn').value || '').trim(),
      ogrn: (el('ogrn').value || '').trim(),
      legal_address: (el('legal_address').value || '').trim(),
      postal_address: (el('postal_address').value || '').trim(),
      phone: (el('phone').value || '').trim(),
      email: (el('email').value || '').trim()
    };
  }

  function renderSigners(list) {
    const tbody = el('signersTbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    list.forEach((s) => {
      const tr = document.createElement('tr');
      tr.dataset.id = s.id;

      tr.innerHTML = `
        <td><input data-field="fio" type="text" value="${escapeHtml(s.fio || '')}"></td>
        <td><input data-field="position" type="text" value="${escapeHtml(s.position || '')}"></td>
        <td><textarea data-field="basis">${escapeHtml(s.basis || '')}</textarea></td>
        <td class="col-small" style="text-align:center;"><input data-field="is_default" type="radio" name="signer_default" ${s.is_default ? 'checked' : ''}></td>
        <td class="col-small" style="text-align:center;"><input data-field="active" type="checkbox" ${s.active !== false ? 'checked' : ''}></td>
        <td class="col-del" style="text-align:center;"><button type="button" class="btn-del" data-action="delete">X</button></td>
      `;
      tbody.appendChild(tr);
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function collectSignersFromUI() {
    const tbody = el('signersTbody');
    const rows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
    return rows.map(tr => {
      const id = tr.dataset.id || makeId();
      const fio = (tr.querySelector('[data-field="fio"]')?.value || '').trim();
      const position = (tr.querySelector('[data-field="position"]')?.value || '').trim();
      const basis = (tr.querySelector('[data-field="basis"]')?.value || '').trim();
      const is_default = !!(tr.querySelector('[data-field="is_default"]')?.checked);
      const active = !!(tr.querySelector('[data-field="active"]')?.checked);
      return { id, fio, position, basis, is_default, active };
    });
  }

  function bindSigners() {
    const tbody = el('signersTbody');
    const btnAdd = el('btnAddSigner');

    if (btnAdd) {
      btnAdd.addEventListener('click', () => {
        const list = collectSignersFromUI();
        list.push({ id: makeId(), fio: '', position: '', basis: '', is_default: false, active: true });
        renderSigners(list);
      });
    }

    if (tbody) {
      tbody.addEventListener('click', (e) => {
        const btn = e.target;
        if (btn && btn.dataset && btn.dataset.action === 'delete') {
          const tr = btn.closest('tr');
          if (!tr) return;
          const list = collectSignersFromUI().filter(s => s.id !== tr.dataset.id);
          if (list.length && !list.some(s => s.is_default)) list[0].is_default = true;
          renderSigners(list.length ? list : JSON.parse(JSON.stringify(signerDefaults)));
        }
      });
    }
  }

  function bindMain() {
    const btnSave = el('btnSave');
    const btnReset = el('btnReset');
    let busy = false;

    function setBusy(isBusy) {
      busy = !!isBusy;
      if (btnSave) btnSave.disabled = busy;
      if (btnReset) btnReset.disabled = busy;
    }

    btnSave.addEventListener('click', async () => {
      if (busy) return;

      const req = readReqForm();
      if (!req.full_name) {
        setToast('Заполните поле: Полное наименование (как в суде).', 'err');
        el('full_name').focus();
        return;
      }

      const ownerId = getOwnerId();
      console.log('[requisites][save] ownerId=' + ownerId);
      if (!ownerId) {
        setToast('Не определена база пользователя/owner. Сохранение остановлено.', 'err');
        return;
      }

      setBusy(true);
      try {
        const signers = normalizeSigners(collectSignersFromUI());

        const reqRaw = JSON.stringify(req);
        const signersRaw = JSON.stringify(signers);

        storeSet(KEY_REQ, reqRaw, ownerId);
        storeSet(KEY_SIGNERS, signersRaw, ownerId);

        await apiPostStore(ownerId, KEY_REQ, reqRaw);
        await apiPostStore(ownerId, KEY_SIGNERS, signersRaw);

        storeSet(KEY_REQ, reqRaw, ownerId);
        storeSet(KEY_SIGNERS, signersRaw, ownerId);
        console.log('[requisites][cache-sync] updated after api-store');

        await verifySaved(ownerId);

        // Совместимость с data.js (не ломаем старое)
        if (window.AbonentsDB) {
          window.AbonentsDB.orgName = req.full_name;
          if (req.inn) window.AbonentsDB.orgInn = req.inn;

          const def = signers.find(s => s.is_default) || signers[0];
          if (def && def.fio && !window.AbonentsDB.chairman) {
            window.AbonentsDB.chairman = def.fio;
          }
        }

        await uploadOwnerDataOptional();
        setToast('Реквизиты и подписанты сохранены.', 'ok');
      } catch (e) {
        setToast('Ошибка сохранения: ' + (e?.message || e), 'err');
      } finally {
        setBusy(false);
      }
    });

    btnReset.addEventListener('click', async () => {
      if (busy) return;
      if (!confirm('Очистить реквизиты и подписантов?')) return;

      const ownerId = getOwnerId();
      console.log('[requisites][save] ownerId=' + ownerId);
      if (!ownerId) {
        setToast('Не определена база пользователя/owner. Сохранение остановлено.', 'err');
        return;
      }

      setBusy(true);
      try {
        await apiPostStore(ownerId, KEY_REQ, '');
        await apiPostStore(ownerId, KEY_SIGNERS, '');

        storeRemove(KEY_REQ, ownerId);
        storeRemove(KEY_SIGNERS, ownerId);

        await verifyCleared(ownerId);
        await uploadOwnerDataOptional();

        fillReqForm({ ...reqDefaults });
        renderSigners(JSON.parse(JSON.stringify(signerDefaults)));
        setToast('Данные очищены.', 'ok');
      } catch (e) {
        setToast('Ошибка очистки: ' + (e?.message || e), 'err');
      } finally {
        setBusy(false);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const ok = await waitForStoreReady(8000);
    if (!ok) {
      console.error('[requisites][load] store not ready');
      setToast('Ошибка загрузки данных (сервер не готов)', 'err');
      return;
    }
    const ownerId = getOwnerId();
    console.log('[requisites][load] ownerId=' + ownerId);
    fillReqForm(loadReq(ownerId));
    renderSigners(loadSigners(ownerId));
    bindSigners();
    bindMain();
  });

  window.getOrganizationRequisites = function () {
    const ownerId = getOwnerId();
    return loadReq(ownerId);
  };
  window.getOrganizationSigners = function () {
    const ownerId = getOwnerId();
    return loadSigners(ownerId);
  };
})();
