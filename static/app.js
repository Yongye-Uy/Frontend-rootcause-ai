const API_BASE = `${window.API_ORIGIN || ""}/api/sessions`;
const STORAGE_KEY = "rootcause_ai_session_id";
const CLIENT_ID_KEY = "rootcause_ai_client_id";

const STEPS = [
  { key: "intake", label: "Describe" },
  { key: "root_cause_confirm", label: "Clarify & Confirm" },
  { key: "solution_select", label: "Solutions" },
  { key: "done", label: "Plan" },
];

const MAX_CLARIFICATION_ROUNDS = 2;

let state = {
  sessionId: null,
  phase: null,
  problem_text: "",
  qa_pairs: [],
  root_cause: null,
  root_cause_confirmed: false,
  solutions: [],
  selected_solution_id: null,
  plans: [],
  llm_provider_used: null,
  message: null,
};

const app = document.getElementById("app");
const errorBanner = document.getElementById("errorBanner");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingMessageEl = document.getElementById("loadingMessage");
const providerBadge = document.getElementById("providerBadge");
const stepNavEl = document.getElementById("stepNav");

/* ---------- Icons ---------- */

function checkIcon() {
  return '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function downloadIcon() {
  return '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 13h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function externalLinkIcon() {
  return '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 4H4a1 1 0 00-1 1v7a1 1 0 001 1h7a1 1 0 001-1v-2M9 3h4v4M13 3L7 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

/* ---------- Small helpers ---------- */

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function saveSessionId(id) {
  try {
    localStorage.setItem(STORAGE_KEY, String(id));
  } catch (e) {
    /* localStorage unavailable -- session just won't survive a reload */
  }
}

function clearSessionId() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) { }
}

function getClientId() {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch (e) {
    return "anonymous";
  }
}

function setLoading(isLoading, message) {
  loadingOverlay.style.display = isLoading ? "flex" : "none";
  loadingMessageEl.textContent = message || "Thinking…";
}

function showError(msg) {
  errorBanner.innerHTML = `<span class="alert-title">Something went wrong</span>${escapeHtml(msg)}`;
  errorBanner.classList.remove("d-none");
}

function clearError() {
  errorBanner.classList.add("d-none");
}

async function apiCall(path, options, loadingMessage) {
  setLoading(true, loadingMessage);
  clearError();
  try {
    const merged = {
      ...options,
      headers: { ...(options && options.headers), "X-Client-Id": getClientId() },
    };
    const res = await fetch(path, merged);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail || data);
      throw new Error(detail || `Request failed with status ${res.status}`);
    }
    return data;
  } finally {
    setLoading(false);
  }
}

function applyState(data) {
  Object.assign(state, data, { sessionId: data.id });
  saveSessionId(data.id);
  render();
}

function hasPlanFor(solutionId) {
  return state.plans.some((p) => p.solution_id === solutionId);
}

function planFor(solutionId) {
  return state.plans.find((p) => p.solution_id === solutionId);
}

/* ---------- Step nav & provider badge ---------- */

function renderStepNav() {
  const phaseToStep = { rejected_health: "intake", researching: "solution_select", planning: "done" };
  const currentKey = phaseToStep[state.phase] || state.phase || "intake";
  const currentIndex = STEPS.findIndex((s) => s.key === currentKey);

  stepNavEl.innerHTML = STEPS.map((step, i) => {
    const isActive = i === currentIndex;
    const isDone = i < currentIndex;
    const cls = isActive ? "is-active" : isDone ? "is-done" : "";
    const circleContent = isDone ? checkIcon() : String(i + 1);
    const item = `
      <div class="step-nav-item ${cls}">
        <span class="step-nav-circle">${circleContent}</span>
        <span class="step-label">${escapeHtml(step.label)}</span>
      </div>`;
    const connector = i < STEPS.length - 1 ? '<div class="step-nav-connector"></div>' : "";
    return item + connector;
  }).join("");
}

function updateProviderBadge() {
  if (state.llm_provider_used) {
    providerBadge.innerHTML = `<span class="dot"></span>answered via ${escapeHtml(state.llm_provider_used)}`;
    providerBadge.classList.remove("d-none");
  } else {
    providerBadge.classList.add("d-none");
  }
}

/* ---------- Shared fragments ---------- */

function qaHistoryHtml({ collapsed = false } = {}) {
  const answered = state.qa_pairs.filter((qa) => qa.answer !== null);
  if (answered.length === 0) return "";

  const rounds = [...new Set(answered.map((qa) => qa.round))].sort((a, b) => a - b);
  const inner = rounds
    .map((round) => {
      const items = answered
        .filter((q) => q.round === round)
        .map(
          (qa) => `
        <div class="qa-item">
          <div class="qa-question">${escapeHtml(qa.question)}</div>
          <div class="qa-answer">${escapeHtml(qa.answer)}</div>
        </div>`
        )
        .join("");
      return `<div class="qa-round-label">Round ${round}</div>${items}`;
    })
    .join("");

  if (collapsed) {
    return `
      <details class="summary">
        <summary>Investigation summary &middot; ${answered.length} question${answered.length === 1 ? "" : "s"} answered</summary>
        <div class="summary-body">${inner}</div>
      </details>`;
  }
  return `<div class="summary"><div class="summary-body" style="border-top: none;">${inner}</div></div>`;
}

/* ---------- Render dispatch ---------- */

function render() {
  renderStepNav();
  updateProviderBadge();

  if (!state.sessionId) {
    renderIntake();
    return;
  }
  switch (state.phase) {
    case "rejected_health":
      renderHealthRefusal();
      break;
    case "root_cause_confirm":
      renderRootCauseConfirm();
      break;
    case "solution_select":
      renderSolutionSelect();
      break;
    case "done":
      renderPlanDisplay();
      break;
    default:
      renderIntake();
  }
}

/* ---------- Screens ---------- */

function renderIntake() {
  app.innerHTML = `
    <div class="card fade-in">
      <h2 class="card-title">What's the problem?</h2>
      <p class="card-subtitle">
        Describe it in your own words. RootCause AI investigates before it recommends —
        it will ask clarification questions before proposing anything.
      </p>
      <div class="field">
        <textarea id="problemInput" rows="4"
          placeholder="e.g. My laptop keeps randomly shutting down while I'm working."></textarea>
      </div>
      <button id="startBtn" class="btn btn-primary">Start investigation</button>
    </div>`;

  document.getElementById("startBtn").addEventListener("click", async () => {
    const text = document.getElementById("problemInput").value.trim();
    if (!text) {
      showError("Please describe the problem first.");
      return;
    }
    try {
      const data = await apiCall(API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problem_text: text, client_id: getClientId() }),
      });
      applyState(data);
    } catch (e) {
      showError(e.message);
    }
  });

  app.insertAdjacentHTML("beforeend", '<div id="historyList"></div>');
  renderHistoryList();
}

async function fetchHistory() {
  try {
    const res = await fetch(API_BASE, { headers: { "X-Client-Id": getClientId() } });
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    return [];
  }
}

function historyItemHtml(item) {
  const date = new Date(item.updated_at).toLocaleString();
  const phaseLabel = item.phase.replace(/_/g, " ");
  const preview =
    item.problem_text.length > 80 ? `${item.problem_text.slice(0, 80)}…` : item.problem_text;
  return `
    <button type="button" class="history-item" data-resume-session="${item.id}">
      <span class="history-item-text">${escapeHtml(preview)}</span>
      <span class="history-item-meta">${escapeHtml(phaseLabel)} &middot; ${escapeHtml(date)}</span>
    </button>`;
}

async function renderHistoryList() {
  const container = document.getElementById("historyList");
  if (!container) return;
  const history = await fetchHistory();
  const stillMounted = document.getElementById("historyList");
  if (!stillMounted || history.length === 0) return;

  stillMounted.innerHTML = `
    <div class="card fade-in mt-6">
      <h2 class="card-title" style="font-size:1rem;">Your past investigations</h2>
      ${history.map(historyItemHtml).join("")}
    </div>`;

  stillMounted.querySelectorAll("[data-resume-session]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = parseInt(btn.dataset.resumeSession, 10);
      try {
        const data = await apiCall(`${API_BASE}/${id}`, undefined, "Restoring your session…");
        applyState(data);
      } catch (err) {
        showError(err.message);
      }
    });
  });
}

function renderHealthRefusal() {
  app.innerHTML = `
    <div class="alert alert-warning fade-in">
      <span class="alert-title">Can't help with this one</span>
      ${escapeHtml(state.message)}
    </div>
    <button id="restartBtn" class="btn btn-secondary">Describe a different problem</button>`;
  document.getElementById("restartBtn").addEventListener("click", resetToIntake);
}

function renderRootCauseConfirm() {
  const unanswered = state.qa_pairs.filter((qa) => qa.answer === null);
  const currentRound = unanswered.length ? unanswered[0].round : null;

  let questionsFormHtml = "";
  if (unanswered.length > 0) {
    questionsFormHtml = `
      <hr style="margin: var(--space-5) 0; border-color: var(--border-color);" />
      <h3 class="card-title" style="font-size:1.1rem;">Optional: Help me refine this</h3>
      <p class="text-muted" style="margin-bottom: var(--space-4);">If the root cause above doesn't seem quite right, answering these questions will help me get a better result.</p>
      <form id="answersForm">
        ${unanswered
        .map(
          (qa, i) => `
          <div class="field">
            <label>${escapeHtml(qa.question)}</label>
            <input type="text" data-qa-id="${qa.round}-${i}" required />
          </div>`
        )
        .join("")}
        <button type="submit" class="btn btn-secondary">Submit Answers</button>
      </form>
    `;
  }

  app.innerHTML = `
    ${qaHistoryHtml()}
    <div class="card fade-in">
      ${state.message ? `<div class="alert alert-info">${escapeHtml(state.message)}</div>` : ""}
      <h2 class="card-title">Here's what I think is going on</h2>
      <p class="card-subtitle" style="font-size:1.05rem; color: var(--text-primary);">${escapeHtml(state.root_cause)}</p>
      <p class="text-muted" style="margin-bottom: var(--space-4);">Does that sound right?</p>
      <div class="meta-row">
        <button id="confirmYes" class="btn btn-primary">Yes, that's it</button>
        <button id="confirmNo" class="btn btn-secondary">No, that's not it</button>
      </div>
      <div id="feedbackWrap" class="d-none mt-6">
        <div class="field">
          <label>What did I get wrong? (optional)</label>
          <textarea id="feedbackInput" rows="2"></textarea>
        </div>
        <button id="sendRejection" class="btn btn-danger btn-sm">Send feedback</button>
      </div>
      ${questionsFormHtml}
    </div>`;

  document.getElementById("confirmYes").addEventListener("click", () => submitConfirmation(true));
  document.getElementById("confirmNo").addEventListener("click", () => {
    document.getElementById("feedbackWrap").classList.remove("d-none");
  });
  document.getElementById("sendRejection").addEventListener("click", () => {
    const feedback = document.getElementById("feedbackInput").value.trim();
    submitConfirmation(false, feedback);
  });

  if (unanswered.length > 0) {
    document.getElementById("answersForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const inputs = [...document.querySelectorAll("[data-qa-id]")];
      const answers = inputs.map((el) => el.value.trim());
      if (answers.some((a) => !a)) {
        showError("Please answer every question.");
        return;
      }
      try {
        const data = await apiCall(`${API_BASE}/${state.sessionId}/answers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers }),
        }, "Refining root cause...");
        applyState(data);
      } catch (err) {
        showError(err.message);
      }
    });
  }
}

async function submitConfirmation(confirmed, feedback) {
  const loadingMessage = confirmed
    ? "Researching real solutions and sources — this can take up to a minute…"
    : "Thinking…";
  try {
    const data = await apiCall(
      `${API_BASE}/${state.sessionId}/confirm-root-cause`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed, feedback: feedback || null }),
      },
      loadingMessage
    );
    applyState(data);
  } catch (err) {
    showError(err.message);
  }
}

function listHtml(className, items) {
  if (!items || items.length === 0) return "";
  return `<ul class="trait-list ${className}">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
}

function sourceLinksHtml(sources) {
  if (!sources || sources.length === 0) {
    return '<p class="text-muted" style="font-size:0.85rem;">No sources given.</p>';
  }
  return `<div class="source-links">${sources
    .map(
      (src) =>
        `<a class="source-link" href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer">${externalLinkIcon()} ${escapeHtml(src.title)}</a>`
    )
    .join("")}</div>`;
}

function solutionCardHtml(sol) {
  const isSelected = state.selected_solution_id === sol.id;
  const alreadyPlanned = hasPlanFor(sol.id);
  const btnLabel = alreadyPlanned ? "View Plan" : "Generate Plan";

  return `
    <div class="card solution-card fade-in ${isSelected ? "is-selected" : ""}">
      <div class="solution-card-head">
        <span class="solution-rank">${sol.rank}</span>
        <h3 class="card-title" style="font-size:1.05rem;">${escapeHtml(sol.name)}</h3>
      </div>
      <p style="margin-bottom: var(--space-3);">${escapeHtml(sol.explanation)}</p>
      <p class="text-muted" style="font-size:0.85rem; margin-bottom: var(--space-3);">
        <strong style="color: var(--text-secondary);">Resources:</strong> ${escapeHtml(sol.resources)}
      </p>
      <div class="meta-row">
        <span class="pill-badge">Cost: ${escapeHtml(sol.cost)}</span>
        <span class="pill-badge">Difficulty: ${escapeHtml(sol.difficulty)}</span>
        <span class="pill-badge">Time: ${escapeHtml(sol.time_estimate)}</span>
      </div>

      <div class="trait-grid">
        <div>
          <div class="trait-label">Advantages</div>
          ${listHtml("pros", sol.pros)}
        </div>
        <div>
          <div class="trait-label">Disadvantages</div>
          ${listHtml("cons", sol.cons)}
        </div>
        <div>
          <div class="trait-label">Risks</div>
          ${listHtml("risks", sol.risks)}
        </div>
      </div>

      <div class="trait-label">Sources</div>
      ${sourceLinksHtml(sol.sources)}

      <button class="btn btn-primary btn-block" data-select-solution="${sol.id}" data-cached="${alreadyPlanned}">
        ${btnLabel}
      </button>
    </div>`;
}

function renderSolutionSelect() {
  app.innerHTML = `
    ${qaHistoryHtml({ collapsed: true })}
    <div class="alert alert-info">
      <span class="alert-title">Confirmed root cause</span>
      ${escapeHtml(state.root_cause)}
    </div>
    ${state.message ? `<p class="text-muted" style="margin-bottom: var(--space-4);">${escapeHtml(state.message)}</p>` : ""}
    <h2 class="card-title mt-6" style="margin-bottom: var(--space-4);">Top ${state.solutions.length} solutions</h2>
    <div class="solution-grid">
      ${state.solutions.map(solutionCardHtml).join("")}
    </div>`;

  document.querySelectorAll("[data-select-solution]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const solutionId = parseInt(btn.dataset.selectSolution, 10);
      const cached = btn.dataset.cached === "true";
      const loadingMessage = cached
        ? "Loading your saved plan…"
        : "Building your implementation plan — this can take up to a minute…";
      try {
        const data = await apiCall(
          `${API_BASE}/${state.sessionId}/select-solution`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ solution_id: solutionId }),
          },
          loadingMessage
        );
        applyState(data);
      } catch (err) {
        showError(err.message);
      }
    });
  });
}

function orderedListHtml(items) {
  if (!items || items.length === 0) return '<p class="text-muted">None given.</p>';
  return `<ol class="plan-steps">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ol>`;
}

function renderPlanDisplay() {
  const selected = state.solutions.find((s) => s.id === state.selected_solution_id);
  const plan = planFor(state.selected_solution_id);

  if (!plan) {
    app.innerHTML = `<div class="alert alert-warning">No plan found for this session.</div>`;
    return;
  }

  app.innerHTML = `
    ${qaHistoryHtml({ collapsed: true })}
    <div class="alert alert-success">
      <span class="alert-title">Plan ready</span>
      ${escapeHtml(selected ? selected.name : "your chosen solution")}
    </div>
    ${state.message ? `<p class="text-muted" style="margin-bottom: var(--space-4);">${escapeHtml(state.message)}</p>` : ""}

    <div class="card fade-in">
      <h2 class="card-title" style="margin-bottom: var(--space-5);">Implementation Plan</h2>

      <div class="plan-section">
        <h3>Overview</h3>
        <p>${escapeHtml(plan.overview)}</p>
      </div>

      <div class="plan-section">
        <h3>Requirements</h3>
        <p>${escapeHtml(plan.requirements)}</p>
      </div>

      <div class="trait-grid plan-section">
        <div>
          <h3>Tools</h3>
          <p>${escapeHtml(plan.tools)}</p>
        </div>
        <div>
          <h3>Cost</h3>
          <p>${escapeHtml(plan.cost)}</p>
        </div>
        <div>
          <h3>Timeline</h3>
          <p>${escapeHtml(plan.timeline)}</p>
        </div>
      </div>

      <div class="plan-section">
        <h3>Step-by-step instructions</h3>
        ${orderedListHtml(plan.steps)}
      </div>

      <div class="plan-section">
        <h3>Possible problems</h3>
        <p>${escapeHtml(plan.possible_problems)}</p>
      </div>

      <div class="plan-section">
        <h3>Alternatives</h3>
        <p>${escapeHtml(plan.alternatives)}</p>
      </div>

      <div class="plan-section" style="margin-bottom: 0;">
        <h3>Sources</h3>
        ${sourceLinksHtml(plan.sources)}
      </div>
    </div>

    <div class="plan-actions">
      <a class="btn btn-secondary" href="${API_BASE}/${state.sessionId}/report.pdf?client_id=${encodeURIComponent(getClientId())}" download>
        ${downloadIcon()} Download as PDF
      </a>
      <button id="chooseAnotherBtn" class="btn btn-secondary">Choose Another Solution</button>
      <button id="restartBtn" class="btn btn-ghost">Start New Investigation</button>
    </div>`;

  document.getElementById("chooseAnotherBtn").addEventListener("click", async () => {
    try {
      const data = await apiCall(`${API_BASE}/${state.sessionId}/back-to-solutions`, { method: "POST" });
      applyState(data);
    } catch (err) {
      showError(err.message);
    }
  });
  document.getElementById("restartBtn").addEventListener("click", resetToIntake);
}

/* ---------- Reset & init ---------- */

function resetToIntake() {
  state = {
    sessionId: null,
    phase: null,
    problem_text: "",
    qa_pairs: [],
    root_cause: null,
    root_cause_confirmed: false,
    solutions: [],
    selected_solution_id: null,
    plans: [],
    llm_provider_used: null,
    message: null,
  };
  clearSessionId();
  clearError();
  render();
}

async function init() {
  const storedId = localStorage.getItem(STORAGE_KEY);
  if (storedId) {
    try {
      const data = await apiCall(`${API_BASE}/${storedId}`, undefined, "Restoring your session…");
      applyState(data);
      return;
    } catch (e) {
      clearSessionId();
    }
  }
  render();
}

init();
