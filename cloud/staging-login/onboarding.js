/** This module runs only after Cognito sign-in and behind the staging feature flag. */
export function attachCandidateSetup(auth) {
  const section = document.querySelector('#candidate-setup');
  const form = document.querySelector('#setup-form');
  const review = document.querySelector('#setup-review');
  const summary = document.querySelector('#setup-summary');
  const status = document.querySelector('#setup-status');
  const planStatus = document.querySelector('#plan-status');
  const save = document.querySelector('#setup-save');
  const edit = document.querySelector('#setup-edit');
  section.hidden = false;
  let pending = null;
  let planActive = false;
  save.disabled = true;

  async function refreshPlan() {
    const token = auth.getIdToken();
    if (!token) {
      planActive = false; save.disabled = true;
      planStatus.textContent = 'Plan status: sign in again to check.';
      return false;
    }
    try {
      const response = await fetch('/api/candidates/plan', { method: 'POST', cache: 'no-store',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}' });
      if (!response.ok) throw new Error('Plan unavailable');
      const plan = await response.json();
      planActive = plan.status === 'active';
      save.disabled = !planActive;
      planStatus.textContent = plan.status === 'active'
        ? `Plan status: ${plan.plan} active until ${new Date(plan.accessUntil).toLocaleDateString()}.`
        : 'Plan status: no active plan. Activate a plan or request an approved free grant before saving.';
      return planActive;
    } catch {
      planActive = false; save.disabled = true;
      planStatus.textContent = 'Plan status is temporarily unavailable.';
      return false;
    }
  }
  void refreshPlan();

  const lines = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  form.addEventListener('input', () => { pending = null; review.hidden = true; });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const resume = data.get('masterResume');
    const transcript = data.get('transcript');
    if (!(resume instanceof File) || !resume.size || resume.size > 5 * 1024 * 1024
      || (transcript instanceof File && resume.size + transcript.size > 5 * 1024 * 1024)) {
      status.textContent = 'PDF uploads must be 5 MB or less in total.';
      return;
    }
    const roles = lines(String(data.get('targetRoles') ?? ''));
    const locations = lines(String(data.get('locations') ?? ''));
    if (!roles.length || !locations.length || roles.length > 12 || locations.length > 12) {
      status.textContent = 'Enter up to 12 roles and 12 locations.';
      return;
    }
    pending = {
      version: 1, submissionId: crypto.randomUUID(), careerStage: String(data.get('careerStage')),
      targetRoles: roles, locations,
      schoolOrEmployer: String(data.get('schoolOrEmployer')).trim(),
      graduationOrExperience: String(data.get('graduationOrExperience')).trim(),
      workAuthorization: String(data.get('workAuthorization')).trim(),
      sponsorshipRequiredNowOrFuture: data.has('sponsorship'), resume, transcript,
    };
    summary.textContent = [
      `Stage: ${pending.careerStage}`, `Roles: ${roles.join(', ')}`, `Locations: ${locations.join(', ')}`,
      `School or employer: ${pending.schoolOrEmployer}`,
      `Graduation or experience: ${pending.graduationOrExperience}`,
      `Work authorization: ${pending.workAuthorization}`,
      `Needs sponsorship: ${pending.sponsorshipRequiredNowOrFuture ? 'Yes' : 'No'}`,
      `Master résumé: ${resume.name}`,
      ...(transcript instanceof File && transcript.size ? [`Transcript: ${transcript.name}`] : []),
    ].join('\n');
    for (const id of ['review-confirmed', 'storage-consent', 'automation-consent']) {
      document.getElementById(id).checked = false;
    }
    review.hidden = false;
    status.textContent = 'Check every answer and consent choice before saving.';
  });

  edit.addEventListener('click', () => { review.hidden = true; pending = null; form.querySelector('select').focus(); });
  save.addEventListener('click', async () => {
    if (!planActive) {
      status.textContent = 'Activate a plan or request an approved free grant before saving.';
      return;
    }
    if (!pending || !['review-confirmed', 'storage-consent', 'automation-consent']
      .every(id => document.getElementById(id).checked)) {
      status.textContent = 'Please review your answers and check all three consent choices.';
      return;
    }
    const token = auth.getIdToken();
    if (!token) { status.textContent = 'Your session expired. Sign in again.'; return; }
    const pdf = async file => {
      if (!(file instanceof File) || !file.size) return undefined;
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      }
      bytes.fill(0);
      return { name: file.name, base64: btoa(binary) };
    };
    save.disabled = true;
    status.textContent = 'Checking your plan…';
    try {
      if (!await refreshPlan()) {
        status.textContent = 'Activate a plan or request an approved free grant before saving.';
        return;
      }
      save.disabled = true;
      status.textContent = 'Saving your private profile…';
      const body = { ...pending, masterResume: await pdf(pending.resume),
        transcript: await pdf(pending.transcript),
        reviewConfirmed: true, storageConsent: true, automationConsent: true };
      delete body.resume;
      if (!body.transcript) delete body.transcript;
      const response = await fetch('/api/candidates/onboarding', {
        method: 'POST', cache: 'no-store',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status === 403) {
        planActive = false;
        save.disabled = true;
        planStatus.textContent = 'Plan status: no active plan. Activate a plan or request an approved free grant.';
        status.textContent = 'Your plan is no longer active. Choose a plan above before saving.';
        return;
      }
      if (!response.ok) throw new Error('Save failed');
      pending = null;
      form.reset();
      form.hidden = true;
      review.hidden = true;
      status.textContent = 'Your reviewed profile was saved. Application runs are not enabled in this staging preview.';
      void refreshPlan();
    } catch {
      status.textContent = 'Profile could not be saved. Check your files and try again.';
      save.disabled = !planActive;
    }
  });
}
