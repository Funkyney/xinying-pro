import type { Page } from "playwright-core";
import { AppError } from "../core/errors";
import { platformFavoriteFlag } from "../shared/platform-favorites";

interface FavoritePage {
  items: Array<{ material_id: string | number; cdn_url: string; tag_list?: unknown; is_liked?: unknown; liked_status?: unknown }>;
  page_info: { total_count: number; total_page: number; page_index: number };
}

/** Use the website's own read-only request client; never access its credentials.
 * A filtered, paginated snapshot is much cheaper than visiting every video. */
export async function readPlatformFavoriteVideos(page: Page, projectId: string): Promise<string[]> {
  const urls: string[] = [], ids = new Set<string>();
  let expectedCount = -1, totalPages = 1;
  try {
    if (!projectId.trim()) throw new Error("缺少心影项目标识");
    for (let pageIndex = 1; pageIndex <= totalPages; pageIndex += 1) {
      const result: FavoritePage = await page.evaluate(async ({ projectId, pageIndex }) => {
        if (location.protocol !== "https:" || location.hostname !== "blueaivideo.com") throw new Error("心影页面未就绪");
        const runtime = (window as unknown as { __?: { a?: (key: string, payload: unknown, options: unknown) => Promise<any> } }).__;
        if (typeof runtime?.a !== "function") throw new Error("官网收藏读取通道不可用");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([
            runtime.a("/materials/list", {
              project_id: projectId, material_type: "video", page_index: pageIndex, page_size: 200,
              filter_source_list: [], material_name: "", tag_list: "", user_tag_list: [],
              filter_material_tag_list: ["liked"], is_ai_processed_filter: false,
              is_deepspace_analysis_filter: false, is_baidu_analysis_filter: false,
            }, { needLoading: false }),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("官网收藏读取超时")), 15_000); }),
          ]);
          if (!response || !Array.isArray(response.items)) throw new Error("官网收藏列表格式变化");
          return {
            page_info: response.page_info,
            items: response.items.map((row: any) => ({ material_id: row.material_id, cdn_url: row.cdn_url,
              tag_list: row.tag_list, is_liked: row.is_liked, liked_status: row.liked_status })),
          };
        } finally { clearTimeout(timer); }
      }, { projectId, pageIndex });
      const info = result.page_info;
      const numeric = (value: unknown) => typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)) ? Number(value) : NaN;
      const count = numeric(info?.total_count), rawPages = numeric(info?.total_page), pages = Math.max(1, rawPages);
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(pages) || pages > 500
        || rawPages < 0 || (count > 0 && rawPages === 0) || numeric(info?.page_index) !== pageIndex
        || (expectedCount >= 0 && (expectedCount !== count || pages !== totalPages))) {
        throw new Error("官网收藏分页数据不完整，请重试");
      }
      expectedCount = count; totalPages = pages;
      for (const row of result.items) {
        const id = String(row.material_id ?? "");
        if (!id || ids.has(id) || platformFavoriteFlag(row) !== true) throw new Error("官网收藏列表不完整，请重试");
        const url = new URL(row.cdn_url);
        if (url.protocol !== "https:") throw new Error("官网收藏缺少有效素材地址");
        ids.add(id); urls.push(url.toString());
      }
    }
    if (ids.size !== expectedCount) throw new Error("官网收藏列表尚未全部加载，请重试");
    return urls;
  } catch (cause) {
    throw new AppError("PLATFORM_FAVORITES_READ_FAILED", `官网收藏同步失败，已保留原有标记：${cause instanceof Error ? cause.message : "请重试"}`);
  }
}
