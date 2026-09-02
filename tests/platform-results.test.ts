import { describe, expect, it } from "vitest";
import {
  canonicalPlatformOutputUrl,
  isPlatformPreviewOutputUrl,
  originalPlatformVideoUrlFromPoster,
  platformPlaybackVideoUrl,
} from "../src/shared/platform-results";

describe("Heart original result URLs", () => {
  it("converts generated preview videos to the original render", () => {
    const preview = "https://blueai-video-global.bluemediacdn.com/vlc-toc/task/img2video/seedance_v2/abc_720p.mp4";
    expect(canonicalPlatformOutputUrl(preview)).toBe("https://blueai-video-global.bluemediacdn.com/vlc-toc/task/img2video/seedance_v2/abc.mp4");
    expect(isPlatformPreviewOutputUrl(preview)).toBe(true);
  });

  it("derives the official download URL from a generated video cover", () => {
    const poster = "https://blueai-video-global.bluemediacdn.com/vlc-toc/task/img2video/seedance_v2/abc_cover.jpg?x-tos-process=image/quality,q_50";
    expect(originalPlatformVideoUrlFromPoster(poster)).toBe("https://blueai-video-global.bluemediacdn.com/vlc-toc/task/img2video/seedance_v2/abc.mp4");
  });

  it("removes image processing parameters without changing unrelated query parameters", () => {
    const preview = "https://blueai-video-global.bluemediacdn.com/vlc-toc/project/original.png?token=ok&x-tos-process=image/resize,w_512";
    expect(canonicalPlatformOutputUrl(preview)).toBe("https://blueai-video-global.bluemediacdn.com/vlc-toc/project/original.png?token=ok");
  });

  it("does not rewrite unrelated hosts", () => {
    const external = "https://media.example/render_720p.mp4";
    expect(canonicalPlatformOutputUrl(external)).toBe(external);
    expect(isPlatformPreviewOutputUrl(external)).toBe(false);
  });

  it("plays Heart MOV originals through the browser-compatible MP4 rendition", () => {
    const output = "https://blueai-video-global.bluemediacdn.com/vlc-toc/task/img2video/seedance_v2/abc.mov";
    const poster = "https://blueai-video-global.bluemediacdn.com/vlc-toc/task/img2video/seedance_v2/abc_cover.jpg?x-tos-process=image/quality,q_50";
    expect(platformPlaybackVideoUrl(output, poster)).toBe(
      "https://blueai-video-global.bluemediacdn.com/vlc-toc/task/img2video/seedance_v2/abc_720p.mp4",
    );
    expect(platformPlaybackVideoUrl("https://media.example/abc.mov", poster)).toBe("https://media.example/abc.mov");
  });
});
