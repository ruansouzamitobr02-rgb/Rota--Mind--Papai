/** Region disambiguation is only enabled for the exact neighborhood Centro. */
export function isCentroNeighborhood(value: string) {
  const name = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return /^(?:(?:campos(?: dos goytacazes)?|sjb|sao joao da barra|sfi|sao francisco de itabapoana) )?centro$/.test(name);
}
