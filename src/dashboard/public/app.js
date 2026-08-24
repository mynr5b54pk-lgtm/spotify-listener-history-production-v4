let chart;
let searchTimer;
let searchController;

const $ = (id) => document.getElementById(id);

function normalizeInput(value) {
  return String(value || "").trim().normalize("NFKC");
}

async function loadArtists({ initial = false } = {}) {
  const q = normalizeInput($("search").value);

  // Do not download/render the old 100-row ranking on first paint. This keeps
  // direct-link startup fast and leaves ranking/detail loading demand-driven.
  if (initial && !q) {
    $("status").textContent = "アーティスト名を2文字以上入力";
    $("artists").innerHTML = "";
    return;
  }
  if (q.length < 2) {
    $("status").textContent = q ? "2文字以上入力してください" : "";
    $("artists").innerHTML = "";
    return;
  }

  if (searchController) searchController.abort();
  searchController = new AbortController();

  try {
    const response = await fetch(`/api/v1/artists?q=${encodeURIComponent(q)}&limit=10`, {
      signal: searchController.signal
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "取得に失敗しました");

    $("status").textContent = body.data.length ? `${body.data.length}件の候補` : "候補なし";
    $("artists").innerHTML = body.data.map((artist) => `
      <article class="card" data-id="${artist.id}">
        <h3>${escapeHtml(artist.name)}</h3>
        <div class="metric">${Number(artist.monthly_listeners_latest || 0).toLocaleString("ja-JP")}</div>
        <div class="muted">月間リスナー</div>
      </article>
    `).join("");

    document.querySelectorAll(".card").forEach((card) => {
      card.addEventListener("click", () => openArtist(card.dataset.id));
    });
  } catch (error) {
    if (error.name === "AbortError") return;
    $("status").textContent = error.message || "取得に失敗しました";
  }
}

function scheduleAutocomplete() {
  clearTimeout(searchTimer);
  const q = normalizeInput($("search").value);
  if (q.length < 2) {
    if (searchController) searchController.abort();
    $("artists").innerHTML = "";
    $("status").textContent = q ? "2文字以上入力してください" : "";
    return;
  }
  searchTimer = setTimeout(() => loadArtists(), 220);
}

async function openArtist(id) {
  const response = await fetch(`/api/v1/artists/${id}`);
  const body = await response.json();
  if (!response.ok) return;

  const artist = body.data;
  $("detail").classList.remove("hidden");
  $("artistName").textContent = artist.name;
  $("artistLatest").textContent = `${Number(artist.monthly_listeners_latest || 0).toLocaleString("ja-JP")} 月間リスナー`;

  if (chart) chart.destroy();
  chart = new Chart($("chart"), {
    type: "line",
    data: {
      labels: artist.history.map((point) => new Date(point.collected_at).toLocaleDateString("ja-JP")),
      datasets: [{ label: "月間リスナー", data: artist.history.map((point) => point.monthly_listeners) }]
    },
    options: { responsive: true }
  });
  $("detail").scrollIntoView({ behavior: "smooth" });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

$("searchButton").addEventListener("click", () => loadArtists());
$("search").addEventListener("input", scheduleAutocomplete);
$("search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    clearTimeout(searchTimer);
    loadArtists();
  }
});
$("closeDetail").addEventListener("click", () => $("detail").classList.add("hidden"));

loadArtists({ initial: true });
