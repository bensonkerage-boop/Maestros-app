/* MASMS: "PDF" button on every list/table.
   Adds a small PDF button above each data table on any page and exports the table
   (school name, title, plain ruled table). Tables that already offer PDF are skipped. */
(function(root, factory){
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.init();
})(typeof window !== 'undefined' ? window : this, function(win){
  var SKIP_ANCESTORS = '.preview-modal,.preview-frame,.receipt-frame,.letterhead,.login-page,.pdf-bar,#classListPreviewRoot,[class*="tt-"],[class*="cal-"],.timetable,.calendar';
  var DROP_HEADER = /^(actions?|options?|manage|edit|delete|view|select|remove|photo|picture|image|tick|✓)$/i;

  function clean(s){ return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function cellText(td){
    var inp = td.querySelector('input:not([type=checkbox]):not([type=radio]):not([type=hidden]),select,textarea');
    if (inp && !clean(td.innerText)) {
      if (inp.tagName === 'SELECT') return clean(inp.options[inp.selectedIndex] ? inp.options[inp.selectedIndex].text : '');
      return clean(inp.value);
    }
    var t = clean(td.innerText != null ? td.innerText : td.textContent);
    if (!t && inp) t = clean(inp.value);
    return t;
  }

  // Reads a <table> into { head:[...], body:[[...]] }, dropping action/blank columns.
  function extract(table){
    var headRow = table.querySelector('thead tr:last-child') || table.querySelector('tr');
    if (!headRow) return null;
    var headCells = Array.prototype.slice.call(headRow.children);
    var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr'));
    if (!rows.length && table.querySelector('thead')) rows = [];
    if (!table.querySelector('thead')) rows = Array.prototype.slice.call(table.querySelectorAll('tr')).slice(1);
    var data = rows.map(function(r){ return Array.prototype.slice.call(r.children).map(cellText); })
      .filter(function(r){ return r.some(function(c){ return c !== ''; }); });
    var heads = headCells.map(function(h){ return clean(h.innerText != null ? h.innerText : h.textContent); });
    var keep = heads.map(function(h, i){
      if (DROP_HEADER.test(h)) return false;
      if (h === '' && data.every(function(r){ return !r[i]; })) return false;
      return true;
    });
    var head = heads.filter(function(_, i){ return keep[i]; });
    var body = data.filter(function(r){ return r.length >= heads.length - 1 || r.length > 1; }).map(function(r){
      return r.slice(0, heads.length).filter(function(_, i){ return keep[i]; });
    });
    return { head: head, body: body };
  }

  function eligible(table){
    if (table.dataset.pdfBtn) return false;
    if (table.closest(SKIP_ANCESTORS)) return false;
    var d = extract(table);
    if (!d || d.head.length < 2 || d.body.length < 1) return false;
    // already has a PDF download nearby (e.g. reports with their own export menu)?
    var scope = table.closest('.panel,.settings-card,section') || table.parentElement;
    if (scope && /\bPDF\b/.test(clean(scope.innerText || '').replace(/[^\w ]/g, ' ')) && scope.querySelector('button[onclick*="Pdf"],button[onclick*="PDF"],a[onclick*="Pdf"],option[value="pdf"],[onclick*="download"]')) return false;
    return true;
  }

  function titleFor(table){
    var d = win.document;
    var panel = table.closest('.panel,.settings-card');
    var h = panel && panel.querySelector('.panel-header h3,h3,h2');
    var page = d.querySelector('.subbar-title');
    var t = clean(h ? h.textContent : '') || clean(page ? page.textContent : '') || 'List';
    var p = clean(page ? page.textContent : '');
    if (p && t !== p && t.toUpperCase().indexOf(p.toUpperCase()) < 0) t = p + ' - ' + t;
    return t;
  }

  function slug(s){ return String(s).replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'list'; }

  function exportPdf(table){
    var W = win;
    if (!W.jspdf || !W.jspdf.jsPDF) { W.alert("PDF export isn't available right now (the PDF library didn't load)."); return; }
    var d = extract(table);
    if (!d || !d.body.length) { W.alert('There is nothing in this list to download.'); return; }
    var title = titleFor(table).toUpperCase();
    var doc = new W.jspdf.jsPDF({ orientation: d.head.length > 7 ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
    var pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight(), margin = 36;
    var school = 'MASMS'; try { if (typeof currentSchool === 'string' && currentSchool) school = currentSchool; } catch (e) {}
    var y = 50;
    try {
      var prof = W.getSchoolProfile(school), rgb = W.hexToRgb(prof.nameColor);
      doc.setFont(W.pdfFontForSchoolName(prof.nameFont), 'bold');
      doc.setFontSize(Math.round(prof.nameSize * 0.75));
      doc.setTextColor(rgb[0], rgb[1], rgb[2]);
    } catch (e) { doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(21, 44, 88); }
    doc.text(school, pw / 2, y, { align: 'center' });
    doc.setFont('times', 'normal'); doc.setFontSize(10); doc.setTextColor(0, 0, 0);
    doc.text(title, pw / 2, y + 18, { align: 'center' });
    doc.autoTable({
      startY: y + 26,
      margin: { left: margin, right: margin, bottom: 30 },
      head: [d.head.map(function(h){ return h.toUpperCase(); })],
      body: d.body,
      theme: 'grid',
      styles: { font: 'times', fontSize: 9.5, cellPadding: 3, lineWidth: 0.6, lineColor: [0, 0, 0], textColor: [0, 0, 0], valign: 'middle' },
      headStyles: { fillColor: [255, 255, 255], textColor: [0, 0, 0], fontStyle: 'normal', halign: 'left', lineWidth: 0.6, lineColor: [0, 0, 0] },
      didDrawPage: function(){
        doc.setFont('times', 'normal'); doc.setFontSize(8); doc.setTextColor(90, 90, 90);
        doc.text('Page ' + doc.internal.getCurrentPageInfo().pageNumber, pw - margin, ph - 16, { align: 'right' });
      }
    });
    doc.save(slug(school + '_' + title) + '_' + new Date().toISOString().slice(0, 10) + '.pdf');
  }

  function addButton(table){
    table.dataset.pdfBtn = '1';
    var bar = win.document.createElement('div');
    bar.className = 'pdf-bar no-print';
    bar.style.cssText = 'text-align:right;margin:0 0 6px;';
    var b = win.document.createElement('button');
    b.type = 'button';
    b.title = 'Download this list as PDF';
    b.style.cssText = 'border:1px solid #c8d3e8;background:#fff;color:#254c8a;border-radius:6px;padding:4px 10px;font:600 12px Inter,sans-serif;cursor:pointer';
    b.innerHTML = '<i class="fa-solid fa-file-pdf" style="margin-right:5px"></i>PDF';
    b.onclick = function(ev){ ev.preventDefault(); ev.stopPropagation(); exportPdf(table); };
    bar.appendChild(b);
    var anchor = table, p = table.parentElement;
    if (p && p.children.length === 1 && /auto|scroll/.test((win.getComputedStyle(p).overflowX || ''))) anchor = p;
    if (anchor.parentNode) anchor.parentNode.insertBefore(bar, anchor);
  }

  function scan(){
    var ts = win.document.querySelectorAll('table:not([data-pdf-btn])');
    for (var i = 0; i < ts.length; i++) { try { if (eligible(ts[i])) addButton(ts[i]); } catch (e) {} }
  }

  function init(){
    var d = win.document, timer = null;
    function later(){ clearTimeout(timer); timer = setTimeout(scan, 200); }
    function start(){ new win.MutationObserver(later).observe(d.body, { childList: true, subtree: true }); scan(); }
    if (d.body) start(); else d.addEventListener('DOMContentLoaded', start);
  }
  return { init: init, extract: extract, eligible: eligible, scan: scan, titleFor: titleFor, exportPdf: exportPdf };
});
