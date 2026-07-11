// One home for getting things OUT of the app: clipboard copies with the transient
// "copied ✓" flag (the sizer report, sheet results, and chart csv all share the
// contract) and anchor-click file downloads (sheet JSON, chart PNG).

/** Copy text to the clipboard and flip a flag for a moment (the ✓ feedback). */
export function copyText(text: string, flag: (on: boolean) => void): void {
  void navigator.clipboard?.writeText(text).then(() => {
    flag(true);
    setTimeout(() => flag(false), 1200);
  });
}

/** Trigger a browser download of `href` as `filename`; revoke an object URL after. */
export function download(filename: string, href: string, revoke = false): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
  if (revoke) URL.revokeObjectURL(href);
}
