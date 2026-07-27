let chart;

const $ = (id) => document.getElementById(id);

async function loadArtists() {
  const q = $("search").value.trim();
  $("status").textContent = "読み込み中…";

  const response = await fetch(`/api/v1/artists?q=${encodeURIComponent(q)}&limit=100`);
  const body = await response.json();

  if (!response.ok) {
    $("status").textContent = body.error || "取得に失敗しました";
    return;
  }

  $("status").textContent = `${body.data.length}件`;
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
}

async function openArtist(id) {
  const response = await fetch(`/api/v1/artists/${id}`);
  const body = await response.json();

  if (!response.ok) return;

  const artist = body.data;
  $("detail").classList.remove("hidden");
  $("artistName").textContent = artist.name;
  $("artistLatest").textContent =
    `${Number(artist.monthly_listeners_latest || 0).toLocaleString("ja-JP")} 月間リスナー`;

  if (chart) chart.destroy();

  chart = new Chart($("chart"), {
    type: "line",
    data: {
      labels: artist.history.map((point) =>
        new Date(point.collected_at).toLocaleDateString("ja-JP")
      ),
      datasets: [{
        label: "月間リスナー",
        data: artist.history.map((point) => point.monthly_listeners)
      }]
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

$("searchButton").addEventListener("click", loadArtists);
$("search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadArtists();
});
$("closeDetail").addEventListener("click", () => {
  $("detail").classList.add("hidden");
});

loadArtists();
