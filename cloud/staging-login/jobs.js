export function attachJobMatches(auth) {
  const section = document.querySelector('#job-matches');
  const list = document.querySelector('#jobs-list');
  const status = document.querySelector('#jobs-status');
  const refresh = document.querySelector('#jobs-refresh');
  const more = document.querySelector('#jobs-more');
  section.hidden = false;
  let nextPage = null;
  let busy = false;

  async function load(page = 0) {
    if (busy) return;
    const token = auth.getIdToken();
    if (!token) { status.textContent = 'Your session expired. Sign in again.'; return; }
    busy = true;
    refresh.disabled = true;
    more.disabled = true;
    status.textContent = 'Finding verified employer postings…';
    try {
      const response = await fetch(`/api/jobs/matches?page=${page}`, {
        method: 'GET', cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 403) {
        if (page === 0) list.replaceChildren();
        status.textContent = 'Save a reviewed profile to see matching jobs.';
        more.hidden = true;
        return;
      }
      if (!response.ok) throw new Error('Unavailable');
      const result = await response.json();
      if (!Array.isArray(result.jobs) || result.jobs.length > 10) throw new Error('Invalid response');
      if (page === 0) list.replaceChildren();
      for (const job of result.jobs) {
        const article = document.createElement('article');
        article.className = 'job-card';
        const title = document.createElement('h3');
        title.textContent = job.title;
        const detail = document.createElement('p');
        detail.textContent = `${job.company} · ${job.location} · ${job.provider}`;
        const link = document.createElement('a');
        const url = new URL(job.officialUrl);
        if (url.protocol !== 'https:') throw new Error('Invalid official URL');
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Open official job posting';
        article.append(title, detail, link);
        list.append(article);
      }
      nextPage = Number.isInteger(result.nextPage) && result.nextPage > page && result.nextPage <= 9
        ? result.nextPage : null;
      more.hidden = nextPage === null;
      status.textContent = list.children.length
        ? `Showing ${list.children.length} matching postings. Open the official posting to review it.`
        : 'No matching verified postings are available right now. Try refreshing later.';
    } catch {
      status.textContent = 'Job matches are temporarily unavailable. Try again.';
    } finally { busy = false; refresh.disabled = false; more.disabled = false; }
  }
  refresh.addEventListener('click', () => void load(0));
  more.addEventListener('click', () => { if (nextPage !== null) void load(nextPage); });
  window.addEventListener('openapply:profile-saved', () => void load(0));
  void load(0);
}
