import { CloudRain, Droplets, Wind } from "lucide-react";

export default function LoadingScreen() {
  return (
    <div className="loading-screen">
      <div className="loading-content">
        <div className="loading-icons">
          <CloudRain className="icon-float icon-1" size={48} />
          <Droplets className="icon-float icon-2" size={42} />
          <Wind className="icon-float icon-3" size={46} />
        </div>
        <h1 className="loading-title">Flood Spaces</h1>
        <p className="loading-subtitle">Real-time Bangladesh Flood Forecasting</p>
        <div className="loading-bar">
          <div className="loading-progress" />
        </div>
      </div>
    </div>
  );
}
