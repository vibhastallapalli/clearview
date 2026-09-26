import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { OrdersPage } from "./pages/OrdersPage";
import { OrderPage } from "./pages/OrderPage";
import { CapturePage } from "./pages/CapturePage";
import { Layout } from "./components/Layout";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Phone capture page: no workspace chrome */}
        <Route path="/capture/:code" element={<CapturePage />} />
        <Route element={<Layout />}>
          <Route path="/" element={<OrdersPage />} />
          <Route path="/orders/:id" element={<OrderPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
