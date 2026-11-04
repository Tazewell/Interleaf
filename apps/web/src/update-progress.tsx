import { useEffect } from "react";
import { toast } from "sonner";
import { Progress } from "@interleaf/ui/components/progress";

const megabytes = (bytes: number) => Math.round(bytes / 1024 / 1024);
const updateToast = {
  id: "interleaf-update",
  duration: Infinity,
  className: "update-progress-toast",
};
// Shows desktop update downloads in one persistent toast.
export function useUpdateProgress() {
  useEffect(
    () =>
      window.interleafDesktop?.onUpdateProgress?.((progress) => {
        if (!progress) {
          toast.dismiss(updateToast.id);
          return;
        }
        if (progress.phase === "prepare") {
          toast.loading(`正在准备安装纸间 ${progress.version}`, {
            ...updateToast,
            description: (
              <span className="update-progress-hint">下载和校验已完成。</span>
            ),
          });
          return;
        }
        const { received, total } = progress;
        const percent =
          total !== undefined && total > 0
            ? Math.min(100, Math.max(0, (received / total) * 100))
            : null;
        toast.loading(`正在下载纸间 ${progress.version}`, {
          ...updateToast,
          description: (
            <div className="update-progress-body">
              <div className="update-progress-metrics">
                <span>
                  {total && percent !== null
                    ? `${megabytes(received)} / ${megabytes(total)} MB`
                    : `已下载 ${megabytes(received)} MB`}
                </span>
                {percent !== null && (
                  <span className="update-progress-percent" aria-hidden="true">
                    {Math.floor(percent)}%
                  </span>
                )}
              </div>
              {percent !== null && (
                <Progress aria-label="更新下载进度" value={percent} />
              )}
              <span className="update-progress-hint">
                速度较慢时可开启代理加速。
              </span>
            </div>
          ),
        });
      }),
    [],
  );
}
