import { useState } from "react";
import { Film, ImageOff } from "lucide-react";

export function HistoryPreview({ urls, alt }: { urls: string[]; alt: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const src = urls.find((candidate) => !failed.includes(candidate));
  if (!src) return urls.length
    ? <span className="history-preview-unavailable" role="img" aria-label={`${alt}：预览暂不可用`} title="预览暂不可用，不影响复用官网原素材"><ImageOff size={22} /><small>预览暂不可用</small></span>
    : <Film size={24} />;
  return <img key={src} src={src} alt={alt} loading="lazy" onError={() => setFailed((previous) => previous.includes(src) ? previous : [...previous, src])} />;
}
