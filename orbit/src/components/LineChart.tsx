import React from 'react';
import { View } from 'react-native';
import Svg, { Path, Polyline } from 'react-native-svg';

function buildPath(values: number[], width: number, height: number, padding = 0) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const innerH = height - padding * 2;
  const stepX = width / (values.length - 1 || 1);
  return values.map((v, i) => {
    const x = i * stepX;
    const y = padding + innerH - ((v - min) / range) * innerH;
    return `${x},${y}`;
  });
}

export function Sparkline({ values, color, height = 44 }: { values: number[]; color: string; height?: number }) {
  const width = 140;
  const points = buildPath(values, width, height).join(' ');
  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <Polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function AreaChart({
  values,
  color,
  fillColor,
  height = 130,
}: {
  values: number[];
  color: string;
  fillColor: string;
  height?: number;
}) {
  const width = 300;
  const padding = 8;
  const pts = buildPath(values, width, height, padding);
  const linePoints = pts.join(' ');
  const areaPath = `M0,${height} L${pts.join(' L')} L${width},${height} Z`;
  return (
    <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <Path d={areaPath} fill={fillColor} stroke="none" />
      <Polyline points={linePoints} fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
