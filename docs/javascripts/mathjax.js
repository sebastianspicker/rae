/**
 * Configures MathJax for documentation pages so rendered arithmetic stays consistent with the site theme.
 */
/* global document$ */
window.MathJax = {
  tex: {
    inlineMath: [["\\(", "\\)"]],
    displayMath: [["\\[", "\\]"]],
    processEscapes: true,
    processEnvironments: true,
  },
  options: {
    ignoreHtmlClass: ".*|",
    processHtmlClass: "arithmatex",
  },
};

document$.subscribe(() => {
  if (window.MathJax?.typesetPromise) {
    window.MathJax.typesetPromise();
  }
});
