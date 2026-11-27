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
  const taggedFacts = value => lines(value).map(line => {
    const divider = line.lastIndexOf(' | ');
    if (divider < 1) return null;
    const claim = line.slice(0, divider).trim();
    const skills = line.slice(divider + 3).split(',').map(skill => skill.trim());
    return claim && skills.length <= 12 && skills.every(Boolean) ? { claim, skills } : null;
  });
  const invalidate = () => { pending = null; review.hidden = true; };
  const value = (row, name) => row.querySelector(`[name="${name}"]`).value.trim();
  const optionalUrl = (row, name) => {
    const url = value(row, name);
    return url ? { [name]: url } : {};
  };
  const experiences = () => [...form.querySelectorAll('.experience-entry')].map(row => ({
    employer: value(row, 'employer'), title: value(row, 'title'),
    employmentType: value(row, 'employmentType'), start: value(row, 'start'),
    end: value(row, 'end'), claims: taggedFacts(value(row, 'claims')),
  }));
  const projects = () => [...form.querySelectorAll('.project-entry')].map(row => ({
    name: value(row, 'name'), ...optionalUrl(row, 'url'), claims: taggedFacts(value(row, 'claims')),
  }));
  form.addEventListener('input', invalidate);
  for (const kind of ['experience', 'project']) {
    document.getElementById(`add-${kind}`).addEventListener('click', () => {
      const list = document.getElementById(`${kind}-list`);
      if (list.children.length >= 12) { status.textContent = `You can add up to 12 ${kind} entries.`; return; }
      const row = document.getElementById(`${kind}-template`).content.cloneNode(true);
      list.append(row);
      const added = list.lastElementChild;
      added.querySelector('.remove-entry').addEventListener('click', () => { added.remove(); invalidate(); });
      invalidate();
    });
  }
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
    const countries = lines(String(data.get('authorizedCountries') ?? ''));
    const skills = lines(String(data.get('skills') ?? ''));
    const education = taggedFacts(String(data.get('educationFacts') ?? ''));
    const experience = experiences();
    const projectFacts = projects();
    if (!roles.length || !locations.length || !countries.length
      || roles.length > 12 || locations.length > 12 || countries.length > 12
      || skills.length > 80 || education.length > 12
      || !['yes', 'no'].includes(String(data.get('sponsorship')))) {
      status.textContent = 'Check your roles, locations, work authorization, and facts before review.';
      return;
    }
    if (!education.length && !experience.length && !projectFacts.length) {
      status.textContent = 'Enter at least one education, experience, or project fact.';
      return;
    }
    if (education.includes(null) || experience.some(item => item.claims.includes(null))
      || projectFacts.some(item => item.claims.includes(null))) {
      status.textContent = 'Each fact needs its own accurate skill tags after a |, separated by commas.';
      return;
    }
    const sponsorshipRequiredNowOrFuture = data.get('sponsorship') === 'yes';
    const applicationFacts = {
      identity: {
        fullName: String(data.get('fullName')).trim(),
        email: String(data.get('applicationEmail')).trim(),
        phone: String(data.get('phone')).trim(),
        location: String(data.get('currentLocation')).trim(),
        ...optionalUrl(form, 'portfolio'), ...optionalUrl(form, 'github'),
        ...optionalUrl(form, 'linkedin'),
      },
      authorization: { countries, sponsorshipRequiredNowOrFuture },
      skills, education, experience, projects: projectFacts,
    };
    pending = {
      version: 1, submissionId: crypto.randomUUID(), careerStage: String(data.get('careerStage')),
      targetRoles: roles, locations,
      schoolOrEmployer: String(data.get('schoolOrEmployer')).trim(),
      graduationOrExperience: String(data.get('graduationOrExperience')).trim(),
      workAuthorization: countries.join(', '), sponsorshipRequiredNowOrFuture,
      applicationFacts, resume, transcript,
    };
    summary.textContent = [
      `Stage: ${pending.careerStage}`, `Roles: ${roles.join(', ')}`, `Locations: ${locations.join(', ')}`,
      `Name: ${applicationFacts.identity.fullName}`, `Application email: ${applicationFacts.identity.email}`,
      `Phone: ${applicationFacts.identity.phone}`, `Current location: ${applicationFacts.identity.location}`,
      ...['portfolio', 'github', 'linkedin'].filter(key => applicationFacts.identity[key])
        .map(key => `${key}: ${applicationFacts.identity[key]}`),
      `School or employer: ${pending.schoolOrEmployer}`,
      `Graduation or experience: ${pending.graduationOrExperience}`,
      `Authorized countries: ${pending.workAuthorization}`,
      `Needs sponsorship: ${pending.sponsorshipRequiredNowOrFuture ? 'Yes' : 'No'}`,
      `Skills: ${skills.join('; ') || 'None entered'}`,
      ...education.map(item => `Education fact: ${item.claim} [skills used: ${item.skills.join(', ')}]`),
      ...experience.flatMap(item => [`Experience: ${item.employer} — ${item.title} (${item.employmentType}, ${item.start} to ${item.end})`,
        ...item.claims.map(claim => `  Achievement: ${claim.claim} [skills used: ${claim.skills.join(', ')}]`)]),
      ...projectFacts.flatMap(item => [`Project: ${item.name}${item.url ? ` (${item.url})` : ''}`,
        ...item.claims.map(claim => `  Project fact: ${claim.claim} [skills used: ${claim.skills.join(', ')}]`)]),
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
      document.getElementById('experience-list').replaceChildren();
      document.getElementById('project-list').replaceChildren();
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
