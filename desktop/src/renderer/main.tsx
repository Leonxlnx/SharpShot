import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/pages.css";
import "./styles/editor.css";
import "./styles/backgrounds.css";

const root = document.getElementById("root");
if (!root) {
    throw new Error("SharpShot renderer root was not found.");
}

createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
