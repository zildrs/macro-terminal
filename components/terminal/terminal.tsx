"use client";

import { CommandPalette } from "./command-palette";
import { Header } from "./header";
import { Runtime } from "./runtime";
import { StatusBar } from "./status-bar";
import { BalanceSheetChart, FedProbability, RateMatrix } from "@/components/modules/central-bank";
import { AssetChart, CotTracker, OrderflowRadar } from "@/components/modules/cross-asset";
import { EventStream, NewsFeed } from "@/components/modules/intel";
import { CapitalFlowMatrix, NetLiquidityChart, YieldCurveRadar } from "@/components/modules/liquidity";
import { RiskRegime } from "@/components/modules/risk";
import { useTerminal } from "@/lib/store";
import { LAYOUTS, type WidgetId } from "@/lib/views";
import { cn } from "@/lib/utils";

const WIDGETS: Record<WidgetId, React.ComponentType> = {
  rates: RateMatrix,
  fedprob: FedProbability,
  balance: BalanceSheetChart,
  netliq: NetLiquidityChart,
  yield: YieldCurveRadar,
  flows: CapitalFlowMatrix,
  chart: AssetChart,
  cot: CotTracker,
  orderflow: OrderflowRadar,
  events: EventStream,
  news: NewsFeed,
  risk: RiskRegime,
};

export function Terminal() {
  const view = useTerminal((s) => s.view);
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Runtime />
      <Header />
      <main className="min-h-0 flex-1 overflow-auto p-1.5">
        {/* xl: fixed 12×6 terminal grid filling the viewport. Below xl: stacked panes that scroll. */}
        <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2 xl:h-full xl:min-h-[700px] xl:grid-cols-12 xl:grid-rows-6">
          {LAYOUTS[view].map(({ id, cls }) => {
            const Widget = WIDGETS[id];
            return (
              <div key={id} className={cn("flex h-[330px] min-h-0 min-w-0 xl:h-auto [&>section]:flex-1", cls)}>
                <Widget />
              </div>
            );
          })}
        </div>
      </main>
      <StatusBar />
      <CommandPalette />
    </div>
  );
}
