export function createBackupSessionStore() {
  let activeBackup = null;

  function getLoadedOrRespond(res) {
    if (!activeBackup || !activeBackup.index?.loaded) {
      res.status(400).json({
        error: "No backup is loaded. Open a backup folder first.",
      });
      return null;
    }
    return activeBackup;
  }

  return {
    get() {
      return activeBackup;
    },
    set(nextBackup) {
      activeBackup = nextBackup;
    },
    clear() {
      activeBackup = null;
    },
    getLoadedOrRespond,
  };
}
