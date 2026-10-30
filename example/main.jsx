/* eslint-disable react-refresh/only-export-components -- entry file */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Turntable } from "../src/client/index.js";
import "../src/style.css";

const demo = new URLSearchParams(location.search).get("demo");

function App() {
  return (
    <main style={{ font: "15px/1.6 system-ui, sans-serif", color: "#1a1a1a", maxWidth: 560, margin: "18vh auto", padding: "0 24px" }}>
      <h1 style={{ fontSize: 28, margin: "0 0 8px" }}>spotify-turntable</h1>
      <p style={{ margin: "0 0 16px", color: "#6b6b6b" }}>
        The card in the corner shows what your Spotify account is playing. Not connected yet? Run <code>npm run auth</code> and restart.
      </p>
      <p style={{ margin: 0 }}>
        Preview without Spotify: <a href="?demo=live">live</a> · <a href="?demo=rotation">rotation</a> · <a href="?">real</a>
      </p>
      <Turntable floating demo={demo} />
    </main>
  );
}

document.body.style.margin = "0";
document.body.style.background = "#f6f3ee";
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
