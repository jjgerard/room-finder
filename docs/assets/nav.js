/**
 * The Timetables menu in the bar.
 *
 * This lives in one file because it did not, and the copies drifted: three
 * pages carried the same twenty lines, a fourth was rewritten and lost them,
 * and the menu on that page simply stopped opening. Nothing said so — the
 * button was still there and still looked like a button.
 */
;(function () {
  'use strict';

  function wire(wrap, trigger) {
    if (!wrap || !trigger || wrap.dataset.wired) return;
    wrap.dataset.wired = '1';
    var hoverable = function () { return matchMedia('(hover: hover)').matches; };
    function open() { wrap.classList.add('open'); trigger.setAttribute('aria-expanded', 'true'); }
    function close() { wrap.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false'); }

    wrap.addEventListener('mouseenter', function () { if (hoverable()) open(); });
    wrap.addEventListener('mouseleave', function () { if (hoverable()) close(); });
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      // Where hover has already opened it, a click must not close it: the
      // pointer is over the trigger, so it would reopen at once and read as
      // the menu refusing to open.
      if (!wrap.classList.contains('open')) open();
      else if (!hoverable()) close();
    });
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    wrap.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.drop-item')) close();
    });
    return { open: open, close: close };
  }

  function boot() {
    wire(document.getElementById('nav-terms'), document.getElementById('nav-terms-btn'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.TTNav = { wire: wire };
})();
