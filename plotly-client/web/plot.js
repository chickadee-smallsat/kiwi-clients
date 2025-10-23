// plot.js

const MAX_POINTS = 100;
const plotBuffers = {}; // Store data per sensor/section

function initPlots(prefix) {
  // Initialize data buffers
  plotBuffers[prefix] = {
    tData: Array(MAX_POINTS).fill(undefined),
    xData: Array(MAX_POINTS).fill(undefined),
    yData: Array(MAX_POINTS).fill(undefined),
    zData: Array(MAX_POINTS).fill(undefined),
    mData: Array(MAX_POINTS).fill(undefined),
    thetaData: Array(2).fill(undefined),
    thetaAngle: Array(2).fill(undefined),
    phiData: Array(2).fill(undefined),
    phiAngle: Array(2).fill(undefined),
  };

  // XYZ Plot
  Plotly.newPlot(
    `${prefix}-xyz`,
    [
      { y: [], mode: "lines", name: "X", line: { color: "red" } },
      { y: [], mode: "lines", name: "Y", line: { color: "green" } },
      { y: [], mode: "lines", name: "Z", line: { color: "blue" } },
      { y: [], mode: "lines", name: "Magnitude", line: { color: "black" } },
    ],
    {
      title: "X, Y, Z Acceleration",
      xaxis: {
        title: {
          text: "Time (s)",
          font: {
            family: "Courier New, monospace",
            size: 8,
            color: "#7f7f7f",
          },
        },
      },
      yaxis: {
        title: {
          text: "Acceleration (m/s²)",
          font: {
            family: "Courier New, monospace",
            size: 8,
            color: "#7f7f7f",
          },
        },
      },
    }
  );

  // Theta Polar Plot
  Plotly.newPlot(
    `${prefix}-theta`,
    [
      {
        type: "scatterpolar",
        r: [],
        theta: [],
        mode: "lines+markers",
        name: "Theta",
      },
    ],
    {
      polar: { radialaxis: { visible: false}, sector: [0, 180] },
      title: "Theta (from Z-axis)",
    }
  );

  // Phi Polar Plot
  Plotly.newPlot(
    `${prefix}-phi`,
    [
      {
        type: "scatterpolar",
        r: [],
        theta: [],
        mode: "lines+markers",
        name: "Phi",
      },
    ],
    {
      polar: { radialaxis: { visible: false } },
      title: "Phi (in XY-plane)",
    }
  );
}

function updatePlots(prefix, t, x, y, z) {
  const buffer = plotBuffers[prefix];
  if (!buffer) return;

  const {
    tData,
    xData,
    yData,
    zData,
    mData,
    thetaData,
    thetaAngle,
    phiData,
    phiAngle,
  } = buffer;

  if (xData.length >= MAX_POINTS) {
    tData.shift();
    xData.shift();
    yData.shift();
    zData.shift();
    mData.shift();
  }

  tData.push(t);
  xData.push(x);
  yData.push(y);
  zData.push(z);

  const mag = Math.sqrt(x * x + y * y + z * z);
  const theta = Math.acos(z / mag) * (180 / Math.PI);
  const phi = Math.atan2(y, x) * (180 / Math.PI);
  mData.push(mag);

  thetaData[0] = 0;
  thetaAngle[0] = 0; // plot as radius with angle theta
  thetaData[1] = mag;
  thetaAngle[1] = theta;
  phiData[0] = 0;
  phiAngle[0] = 0;
  phiData[1] = 1; // constant radius
  phiAngle[1] = (phi + 360) % 360; // normalize angle
  Plotly.update(`${prefix}-xyz`, {
    x: [tData],
    y: [xData, yData, zData, mData],
  });

  Plotly.update(`${prefix}-theta`, {
    r: [thetaData],
    theta: [thetaAngle],
  });

  Plotly.update(`${prefix}-phi`, {
    r: [phiData],
    theta: [phiAngle],
  });
}

/**
 * Parse a SingleMeasurement JSON object produced by serde
 * @param {string|object} input - JSON string or already parsed object
 * @returns {{measurement: object, timestamp: number}}
 */
function parseSingleMeasurement(input) {
  // Parse string input to object if needed
  const data = typeof input === 'string' ? JSON.parse(input) : input;

  if (typeof data !== 'object' || data === null) {
    throw new Error('Invalid JSON: expected object');
  }

  const { measurement, timestamp } = data;

  if (!measurement || typeof timestamp !== 'number') {
    throw new Error('Invalid SingleMeasurement format');
  }

  // Extract enum variant
  const variantNames = Object.keys(measurement);
  if (variantNames.length !== 1) {
    throw new Error('Invalid CommonMeasurement: expected exactly one variant');
  }

  const variant = variantNames[0];
  const values = measurement[variant];

  switch (variant) {
    case 'Accel':
    case 'Gyro':
    case 'Mag':
    case 'Baro':
    case 'Humi':
      if (!Array.isArray(values) || values.length !== 3) {
        throw new Error(`${variant} must have 3 numeric values`);
      }
      return {
        measurement: { type: variant, x: values[0], y: values[1], z: values[2] },
        timestamp,
      };

    case 'Temp':
    case 'Lux':
      if (!Array.isArray(values) || values.length !== 2) {
        throw new Error('Temp must have [string, number]');
      }
      return {
        measurement: { type: variant, label: values[0], value: values[1] },
        timestamp,
      };

    default:
      throw new Error(`Unknown measurement variant: ${variant}`);
  }
}