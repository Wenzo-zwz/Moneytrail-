import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import AccountApp from "./AccountApp";
import "./styles.css";
import "./auth.css";
import "./admin.css";

if (import.meta.env.PROD) registerSW({ immediate: true });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AccountApp />
  </React.StrictMode>,
);
