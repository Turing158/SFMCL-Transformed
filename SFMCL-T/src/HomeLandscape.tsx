// A quiet, theme-aware pixel horizon for the home page's clean mode.
export function HomeLandscape() {
  return (
    <svg
      className="home-landscape"
      viewBox="0 0 640 320"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <g className="home-landscape-sky">
        <path d="M458 38h36v36h-36z M364 72h6v6h-6z M540 112h6v6h-6z M258 52h6v6h-6z" />
        <path d="M312 116h28v-8h36v8h24v8h-88z M500 90h16v-8h28v8h20v8h-64z" />
      </g>
      <path
        className="home-landscape-far"
        d="M72 320V264h40v-28h40v-32h40v-28h40v-32h48v32h32v24h40v32h40v32h48v56z"
      />
      <path
        className="home-landscape-near"
        d="M288 320v-52h40v-32h40v-40h40v-32h48v-36h48v36h32v32h32v40h40v32h32v52z"
      />
      <path
        className="home-landscape-ground"
        d="M0 320v-16h88v-8h72v8h80v-16h80v-8h80v8h96v-12h80v12h64v32z"
      />
      <g className="home-landscape-trees">
        <path d="M176 264h8v40h-8z M156 264v-16h8v-16h8v-16h16v16h8v16h8v16z" />
        <path d="M556 242h8v46h-8z M536 242v-16h8v-16h8v-16h16v16h8v16h8v16z" />
      </g>
    </svg>
  );
}
