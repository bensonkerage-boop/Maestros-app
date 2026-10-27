/** @jest-environment jsdom */
const dm = require('../scripts/dark-mode.js');
const html = () => document.documentElement;
beforeEach(() => { localStorage.clear(); html().removeAttribute('data-theme'); document.body.innerHTML = ''; document.getElementById('masmsThemeBtn')?.remove(); document.getElementById('masmsThemeCss')?.remove(); window.matchMedia = undefined; });

test('defaults to light when nothing is saved and the system has no preference', () => {
  expect(dm.resolve()).toBe('light');
});
test('follows the system dark preference when nothing is saved', () => {
  window.matchMedia = () => ({ matches: true });
  expect(dm.resolve()).toBe('dark');
});
test('a saved choice beats the system preference', () => {
  window.matchMedia = () => ({ matches: true });
  localStorage.setItem(dm.KEY, 'light');
  expect(dm.resolve()).toBe('light');
  localStorage.setItem(dm.KEY, 'garbage');
  expect(dm.resolve()).toBe('dark');
});
test('init sets the theme, injects css once and mounts one button', () => {
  dm.init(); dm.init();
  expect(html().getAttribute('data-theme')).toBe('light');
  expect(document.querySelectorAll('#masmsThemeCss')).toHaveLength(1);
  expect(document.querySelectorAll('#masmsThemeBtn')).toHaveLength(1);
});
test('toggle switches theme, persists it and updates the button', () => {
  dm.init();
  const b = document.getElementById('masmsThemeBtn');
  b.click();
  expect(html().getAttribute('data-theme')).toBe('dark');
  expect(localStorage.getItem(dm.KEY)).toBe('dark');
  expect(b.getAttribute('aria-pressed')).toBe('true');
  expect(b.title).toMatch(/light/i);
  b.click();
  expect(html().getAttribute('data-theme')).toBe('light');
  expect(localStorage.getItem(dm.KEY)).toBe('light');
});
test('toggling adds the animation class only temporarily', () => {
  jest.useFakeTimers(); dm.init();
  document.getElementById('masmsThemeBtn').click();
  expect(html().classList.contains('theme-anim')).toBe(true);
  jest.advanceTimersByTime(700);
  expect(html().classList.contains('theme-anim')).toBe(false);
  jest.useRealTimers();
});
test('still works when localStorage throws', () => {
  const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  const set = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(() => { dm.init(); document.getElementById('masmsThemeBtn').click(); }).not.toThrow();
  expect(html().getAttribute('data-theme')).toBe('dark');
  spy.mockRestore(); set.mockRestore();
});
