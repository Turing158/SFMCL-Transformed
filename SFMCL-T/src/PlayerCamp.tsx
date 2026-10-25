import { useId } from "react";

export function PlayerCamp() {
  const glowId = useId();
  return (
    <div className="players-login-camp" aria-hidden="true">
      <svg viewBox="0 0 470 164" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id={glowId}>
            <stop stopColor="#efb55c" stopOpacity=".65" />
            <stop offset="1" stopColor="#efb55c" stopOpacity="0" />
          </radialGradient>
        </defs>
        <path
          className="camp-cloud"
          d="M48 38h13V28h24v10h17v9H48Zm283-17h14V11h27v10h16v8h-57Z"
        />
        <g className="camp-sun" fill="#d3bd7e">
          <path opacity=".2" d="M402 32h22v22h-22Z" />
          <path opacity=".7" d="M407 37h12v12h-12Z" />
        </g>
        <path
          className="camp-moon"
          fill="#c6d2a4"
          opacity=".8"
          d="M412 33h9v5h-5v12h8v-4h5v10h-17v-5h-5V38h5Z"
        />
        <g className="camp-distance">
          <path d="M20 95h10V83h12v12h15v20H20Zm364-13h12V68h17v14h11v25h-40Zm51 16h10v-8h9v8h9v18h-28Z" />
          <path d="M37 112h7v13h-7Zm363-9h7v16h-7Z" />
        </g>
        <path className="camp-shadow" d="m60 139 177-36 173 35-171 26Z" />
        <path className="camp-earth" d="m79 106 163 29v18L79 123Z" />
        <path className="camp-earth-dark" d="m242 135 145-30v18l-145 30Z" />
        <path className="camp-grass" d="m79 103 146-30 162 30-145 32Z" />
        <path className="camp-grass-dark" d="m79 103 163 29v7L79 110Z" />
        <path className="camp-leaves-dark" d="m242 132 145-29v7l-145 29Z" />
        <path
          className="camp-grass-light"
          d="m98 103 37-8 23 5-37 8Zm41 13 28-6 20 4-27 6Zm172-15 34-7 22 4-34 8Zm-89-17 19-4 22 4-21 4Z"
        />
        <path
          fill="#c4b386"
          opacity=".8"
          d="m229 128 22-5 13 3-21 5Zm23-10 19-4 15 3-18 4Zm-43-3 16-4 13 3-16 4Z"
        />
        <path
          fill="#ccb084"
          opacity=".7"
          d="m96 115 18 3v5l-18-4Zm27 5 9 2v5l-9-2Zm57 11 14 3v5l-14-3Zm139-4 17-4v5l-17 4Z"
        />
        <g>
          <path className="camp-earth-dark" d="M137 65h9v34l-9 3Z" />
          <path className="camp-earth" d="m132 66 5-1v37l-5-2Z" />
          <path className="camp-leaves-dark" d="m139 37 30-8v37l-30 8Z" />
          <path className="camp-leaves" d="m106 31 33 6v37l-33-7Z" />
          <path className="camp-leaves-light" d="m106 31 29-7 34 5-30 8Z" />
          <path
            className="camp-leaves-light"
            opacity=".45"
            d="m106 41 10 2v9l-10-2Zm19 11 14 3v12l-14-3Zm-9 10 9 2v6l-9-2Z"
          />
          <path
            className="camp-leaves"
            d="m139 43 14-3v12l-14 4Zm18 12 12-3v10l-12 3Z"
          />
        </g>
        <g>
          <path className="camp-earth" d="m300 79 29 6v27l-29-6Z" />
          <path className="camp-earth-dark" d="m329 85 25-6v27l-25 6Z" />
          <path fill="#d0b17e" d="m300 79 25-6 29 6-25 6Z" />
          <path fill="#89694b" d="m307 79 19-4 20 4-19 4Z" />
          <path fill="#c8a778" d="m310 79 16-3 16 3-15 3Z" />
          <path
            stroke="#89694b"
            strokeWidth="1.4"
            d="m315 77 18 4m-10-5 17 4m-7-4-16 5m23-4-17 5"
          />
          <path
            fill="#73573e"
            d="m304 86 6 1v14l-6-1Zm17 4 5 1v14l-5-1Zm-11-1 11 2v4l-11-2Zm25 0 5-1v17l-5 1Zm10-2 5-1v17l-5 1Z"
          />
          <path fill="#c6a778" d="m311 98 8 2v6l-8-2Z" />
        </g>
        <ellipse
          className="camp-glow"
          cx="233"
          cy="101"
          rx="49"
          ry="34"
          fill={`url(#${glowId})`}
          style={{ transformOrigin: "233px 101px" }}
        />
        <g fill="#7c8069">
          <path d="M209 101h8v6h-8Zm9 10h10v5h-10Zm24-1h9v5h-9Zm12-9h7v6h-7Zm-30-11h8v5h-8Zm17 1h7v5h-7Z" />
        </g>
        <path fill="#78563d" d="m218 97 29 9v6l-29-9Zm4 12 27-12v6l-27 12Z" />
        <path fill="#b58a54" d="m218 96 6-2 29 9-6 3Zm-2 11 28-12 6 2-28 12Z" />
        <g className="camp-flame">
          <path
            fill="#d98740"
            d="M221 100V88h5V77h5V66h5v10h5v8h6v16h-5v6h-16v-6Z"
          />
          <path fill="#efb257" d="M226 99V87h5V75h5v12h6v13h-5v4h-7v-5Z" />
        </g>
        <path
          className="camp-flame-inner"
          fill="#ffe09a"
          d="M230 98v-7h4v-9h3v12h3v6h-4v3h-6Z"
        />
        <g fill="#dfaa50">
          <path className="camp-ember" d="M230 62h3v3h-3Z" />
          <path className="camp-ember two" d="M241 72h2v2h-2Z" />
          <path className="camp-ember three" d="M226 74h2v2h-2Z" />
        </g>
        <g className="camp-grass-dark">
          <path d="M177 97h3v12h-3Zm-6-5h3v7h-3Zm3 4h5v3h-5Zm6 4h6v3h-6Zm4-7h3v10h-3ZM281 92h3v12h-3Zm-5-5h3v8h-3Zm2 5h5v3h-5Zm5 5h6v3h-6Zm4-7h3v10h-3Z" />
        </g>
        <g fill="#e0bc71">
          <path d="M170 87h6v6h-6ZM285 85h7v6h-7Z" />
        </g>
        <g className="camp-leaves">
          <path d="M65 125h3v12h-3Zm-7-7h4v9h-4Zm4 6h5v3h-5Zm6 5h5v3h-5Zm3-7h3v10h-3ZM405 119h3v13h-3Zm-6-5h4v9h-4Zm4 6h4v3h-4Zm5 5h6v3h-6Zm5-8h3v11h-3Z" />
        </g>
      </svg>
    </div>
  );
}
