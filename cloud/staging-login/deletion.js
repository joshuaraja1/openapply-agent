/** Staging-only control. The server owns both identity and deletion state. */
export function attachCandidateDeletion(auth) {
  const section = document.querySelector('#candidate-deletion');
  const status = document.querySelector('#deletion-status');
  const confirm = document.querySelector('#deletion-confirm');
  const request = document.querySelector('#deletion-request');
  const refresh = document.querySelector('#deletion-refresh');
  const setup = document.querySelector('#candidate-setup');
  section.hidden = false;
  let current = 'unavailable';
  let busy = false;
  let timer;
  let setupVisibleBeforeRequest = null;

  const render = state => {
    current = state;
    if (state === 'pending' || state === 'complete') {
      setup.hidden = true;
      setupVisibleBeforeRequest = null;
      confirm.value = '';
      confirm.disabled = true;
    } else if (state === 'none' && setupVisibleBeforeRequest !== null) {
      // A failed POST may never have written a tombstone. Only a fresh,
      // authenticated "none" response can restore the prior setup state.
      setup.hidden = !setupVisibleBeforeRequest;
      setupVisibleBeforeRequest = null;
    }
    status.textContent = state === 'none' ? 'No deletion request is pending.'
      : state === 'pending' ? 'Deletion is pending. Application work is blocked while cleanup continues.'
      : state === 'complete' ? 'OpenApply application data cleanup is complete. Your sign-in identity and payment records are handled separately. Applications already sent to employers remain with those employers.'
      : 'Deletion status is unavailable. Refresh to check again.';
    request.disabled = busy || state !== 'none' || confirm.value !== 'DELETE';
    if (timer) clearTimeout(timer);
    if (state === 'pending') timer = setTimeout(() => void checkStatus(), 30_000);
  };
  const call = async path => {
    const token = auth.getIdToken();
    if (!token) throw new Error('Session expired');
    const response = await fetch(path, { method: 'POST', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    if (response.status !== 200 && response.status !== 202) throw new Error('Unavailable');
    const data = await response.json();
    if (!['none', 'pending', 'complete'].includes(data.state)) throw new Error('Invalid state');
    return data.state;
  };
  async function checkStatus() {
    if (busy) return;
    busy = true;
    request.disabled = true;
    try { render(await call('/api/candidates/deletion-status')); }
    catch { render('unavailable'); }
    finally { busy = false; request.disabled = current !== 'none' || confirm.value !== 'DELETE'; }
  }
  confirm.addEventListener('input', () => { request.disabled = busy || current !== 'none' || confirm.value !== 'DELETE'; });
  refresh.addEventListener('click', () => void checkStatus());
  request.addEventListener('click', async () => {
    if (busy || current !== 'none' || confirm.value !== 'DELETE') return;
    busy = true;
    request.disabled = true;
    setupVisibleBeforeRequest = !setup.hidden;
    setup.hidden = true;
    status.textContent = 'Recording your deletion request…';
    try { render(await call('/api/candidates/delete')); }
    catch { render('unavailable'); }
    finally { busy = false; request.disabled = true; }
  });
  void checkStatus();
}
