import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./i18n";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
