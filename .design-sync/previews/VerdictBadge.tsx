import type React from "react";
import { VerdictBadge } from "@cleardock/web-ui";

// Everything in ClearDock renders inside the .app root, which carries the glass backdrop.
const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="app" style={{ padding: 20, borderRadius: 14 }}>
    {children}
  </div>
);

export const AllVerdicts = () => (
  <Surface>
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      <VerdictBadge verdict="match" />
      <VerdictBadge verdict="missing" />
      <VerdictBadge verdict="over" />
      <VerdictBadge verdict="unexpected" />
      <VerdictBadge verdict="billed_mismatch" />
      <VerdictBadge verdict="price_mismatch" />
      <VerdictBadge verdict="unknown" />
    </div>
  </Surface>
);

export const InComparisonTable = () => (
  <Surface>
    <div className="card" style={{ marginBottom: 0 }}>
      <h2>Ordered vs billed vs delivered</h2>
      <p className="warn-text">Billed 3, observed 2: 1 missing ($10.00). 1 × Product B delivered but not ordered or billed.</p>
      <table className="table">
        <thead>
          <tr>
            <th>Product</th>
            <th className="num">Ordered</th>
            <th className="num">Billed</th>
            <th className="num">Delivered</th>
            <th>Result</th>
            <th className="num">At stake</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Product A coffee beans, 500 g bag</td>
            <td className="num">3</td>
            <td className="num">3</td>
            <td className="num">2</td>
            <td>
              <VerdictBadge verdict="missing" />
            </td>
            <td className="num">$10.00</td>
          </tr>
          <tr>
            <td>Product B · 500 g</td>
            <td className="num">—</td>
            <td className="num">—</td>
            <td className="num">1</td>
            <td>
              <VerdictBadge verdict="unexpected" />
            </td>
            <td className="num">—</td>
          </tr>
          <tr>
            <td>Oat milk, 1 L carton</td>
            <td className="num">12</td>
            <td className="num">12</td>
            <td className="num">12</td>
            <td>
              <VerdictBadge verdict="match" />
            </td>
            <td className="num">—</td>
          </tr>
        </tbody>
      </table>
    </div>
  </Surface>
);
