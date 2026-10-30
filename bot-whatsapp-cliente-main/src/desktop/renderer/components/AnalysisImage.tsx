import { ImgHTMLAttributes, useEffect, useState } from "react";
import { getPanelToken } from "../api";

/** Load a photo only while its analysis dialog is open, using the panel session. */
export function AnalysisImage({ src, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const protectedImage = Boolean(src?.startsWith("/api/analysis-preview?"));
  const [photo, setPhoto] = useState<{ source: string; url: string }>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!protectedImage || !src) return;
    const controller = new AbortController();
    let active = true;
    let objectUrl = "";
    setPhoto(undefined);
    setFailed(false);
    const deadline = setTimeout(() => controller.abort(), 15_000);
    void fetch(src, { headers: { "x-panel-token": getPanelToken() }, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Imagem indisponível.");
        const blob = await response.blob();
        if (!active || controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPhoto({ source: src, url: objectUrl });
      })
      .catch(() => { if (active) setFailed(true); })
      .finally(() => clearTimeout(deadline));
    return () => {
      clearTimeout(deadline);
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, protectedImage, retry]);
  if (!protectedImage) return <img {...props} src={src} />;
  if (failed) return <button className="button" type="button" onClick={() => setRetry((value) => value + 1)}>Tentar carregar a imagem novamente</button>;
  return photo?.source === src ? <img {...props} src={photo.url} /> : <span role="status">Carregando imagem...</span>;
}
