import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyViewportMeta } from "./lib/viewMode";
import { installImgRetry } from "./lib/imgRetry";

// 저장된 PC 모드·화면 줌 설정을 첫 렌더 전에 viewport에 반영 (새로고침 후에도 유지)
applyViewportMeta();
// 배포 재시작/네트워크 순단으로 깨진 이미지 자동 재시도 (사용자 제보: '흰 종이' 이미지)
installImgRetry();

createRoot(document.getElementById("root")!).render(<App />);
