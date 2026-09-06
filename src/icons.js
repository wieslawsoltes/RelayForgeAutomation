const paths={
  save:'M3 3h11l3 3v12H3z M6 3v5h7V3 M6 18v-6h8v6',
  open:'M2 6h7l2 2h7l-3 9H2z M2 6V3h6l2 3h7v2',
  undo:'M7 4 3 8l4 4 M3 8h9a5 5 0 0 1 0 10',redo:'M13 4l4 4-4 4 M17 8H8a5 5 0 0 0 0 10',
  compile:'m3 10 4 4 10-10 M3 18h14 M12 12l2 2 4-4',download:'M10 2v11 m-4-4 4 4 4-4 M3 14v4h14v-4',
  run:'m6 3 11 7-11 7z',pause:'M6 3v14 M14 3v14',stop:'M4 4h12v12H4z',step:'m4 4 9 6-9 6z M16 4v12',
  monitor:'M2 3h16v11H2z M6 18h8 M10 14v4 m-5-8 2-2 3 4 3-4 2 2',hmi:'M2 3h16v14H2z M5 6h5v8H5z M13 6h2 M13 9h2 M13 13h2',
  plus:'M10 3v14 M3 10h14',trash:'M3 5h14 M8 2h4l1 3 M5 5l1 13h8l1-13 M8 8v7 M12 8v7',
  folder:'M2 5h6l2 3h8v9H2z',project:'M3 3h5v5H3z M12 3h5v5h-5z M3 12h5v5H3z M12 12h5v5h-5z',
  cpu:'M5 4h10v12H5z M8 1v3 M12 1v3 M8 16v3 M12 16v3 M2 7h3 M2 12h3 M15 7h3 M15 12h3 M8 7h4v6H8z',
  block:'M3 3h14v14H3z M6 7h8 M6 10h8 M6 13h5',tags:'M2 3h8l8 8-7 7-9-9z M6 6h.01',
  table:'M2 3h16v14H2z M2 7h16 M2 12h16 M7 3v14 M13 3v14',trace:'M2 3v14h16 M3 13l4-5 3 3 3-7 4 5',
  settings:'M10 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M10 1v3 M10 16v3 M1 10h3 M16 10h3 M4 4l2 2 M14 14l2 2 M4 16l2-2 M14 6l2-2',
  watch:'M1 10s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6 M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  reset:'M4 6a7 7 0 1 1-1 7 M4 2v5h5',code:'m7 5-5 5 5 5 M13 5l5 5-5 5 M11 3 9 17',
  fit:'M2 7V2h5 M13 2h5v5 M18 13v5h-5 M7 18H2v-5',info:'M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16 M10 9v5 M10 6h.01',
  force:'m11 1-7 10h5l-1 8 8-11h-6z',link:'M8 6 6 4a3 3 0 0 0-4 4l4 4a3 3 0 0 0 4 0 M12 14l2 2a3 3 0 0 0 4-4l-4-4a3 3 0 0 0-4 0 M7 7l6 6',
  up:'m4 13 6-6 6 6',down:'m4 7 6 6 6-6',play:'m7 5 8 5-8 5z',search:'M9 3a6 6 0 1 0 0 12A6 6 0 0 0 9 3 M13 13l5 5',
  export:'M3 11v7h14v-7 M10 13V2 m-4 4 4-4 4 4',copy:'M7 7h11v11H7z M3 13V3h10',back:'m12 4-6 6 6 6'
};
export function icon(name){return `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><path d="${paths[name]||paths.block}"/></svg>`;}
export function escapeHTML(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
