# Snake

A browser Snake game built with plain HTML, CSS, and JavaScript. No frameworks, no build step, no dependencies.

> **Note:** This project started as a quick test run for a new development workflow. It wasn't meant to be more than that, but it came out polished enough that it felt worth keeping and sharing.

## Play

Open `index.html` in any modern browser.

## Features

- **Four difficulty levels**
  - **Easy:** relaxed pace, and the walls wrap around
  - **Normal:** classic pace, and the walls are deadly
  - **Hard:** fast, and it speeds up quickly as you grow
  - **Insane:** blistering speed from the very first move
- **Bonus stars:** a golden star shows up after every 5th food. Grab it before it fades for up to 5× points.
- **High scores** saved separately for each difficulty
- **Sound effects** that you can mute
- **Touch support:** swipe on the board to steer
- **Input buffering** so quick double-turns still register

## Controls

| Key | Action |
| --- | --- |
| Arrow keys / WASD | Steer |
| Enter / Space | Start, or restart after game over |
| Space / P / Esc | Pause and resume |
| R | Restart |
| M | Mute and unmute |
| 1–4 | Pick difficulty (on the menu) |

## Tests

```sh
node tests/game.test.cjs
```

The tests run the real game script against DOM, canvas, and audio test doubles. They need no dependencies, only Node's built-in test runner.
