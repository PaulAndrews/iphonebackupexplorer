export function createStatusLogger(statusContainer) {
  function setStatus(message, isError = false) {
    const text = String(message ?? "").trim();
    if (!text) {
      return;
    }

    const entry = document.createElement("div");
    entry.className = "status-entry";
    if (isError) {
      entry.classList.add("error");
    }
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    entry.textContent = `${hh}:${mm}:${ss} ${text}`;
    statusContainer.appendChild(entry);
    statusContainer.scrollTop = statusContainer.scrollHeight;
  }

  return {
    setStatus,
  };
}
