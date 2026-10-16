
export function cleanupRadixOverlays() {
  // remove any orphaned Radix portals containing dialogs
  const portals = document.querySelectorAll("[data-radix-portal]");
  portals.forEach((p) => {
    const hasDialog = p.querySelector('[role="dialog"],[role="alertdialog"]');
    if (hasDialog) p.remove();
  });

  // also clear any stuck locks
  document.body.style.removeProperty("pointer-events");
  document.documentElement.style.removeProperty("pointer-events");
  document.body.style.overflow = "";
  document.documentElement.style.overflow = "";
}
