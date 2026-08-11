import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyViewportMeta } from "./lib/viewMode";

// 저장된 PC 모드·화면 줌 설정을 첫 렌더 전에 viewport에 반영 (새로고침 후에도 유지)
applyViewportMeta();

createRoot(document.getElementById("root")!).render(<App />);
