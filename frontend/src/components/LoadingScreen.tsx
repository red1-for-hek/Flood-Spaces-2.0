import { CloudRain, Droplets, Waves } from "lucide-react";

export default function LoadingScreen() {
  return (
    <div className="loading-screen">
      <div className="loading-orb" aria-hidden="true" />
      <div className="loading-content">
        <div className="loading-logo-wrap">
          <img src="/logo.png" alt="" className="loading-logo" />
        </div>
        <span className="loading-eyebrow">Bangladesh flood intelligence</span>
        <h1 className="loading-title">Flood Spaces</h1>
        <p className="loading-subtitle">Syncing rainfall, river discharge and satellite signals</p>
        <div className="loading-bar">
          <div className="loading-progress" />
        </div>
        <div className="loading-icons">
          <CloudRain size={16} />
          <Droplets size={16} />
          <Waves size={16} />
        </div>
      </div>
    </div>
  );
}
