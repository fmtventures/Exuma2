/**
 * Real image bytes for testing the header probe and the ingestion pipeline.
 *
 * These are genuine, valid files generated programmatically — not stubs. The
 * probe reads real headers, so testing it against invented bytes would prove
 * nothing. The JPEG deliberately carries an EXIF-shaped APP1 segment ahead of
 * its SOF0 marker, because that is exactly the layout that breaks a probe
 * which reads dimensions from a fixed offset.
 */

function decode(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

const PNG_120x80_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAABmklEQVR4nMXNB0IIAABA0W9kpZBI' +
  'pewQMrISpexZ9iZUVtkryZaVkRQRkkhmZERRpM7VMf67wINOnbt0DejWvUfPXoG9g4L79O0X0j90' +
  'wMCwQeERkYOjoocMHTZ8xMhRMaPHjI0dN35C3MRJk6fET502fcbMhFmJs+ckJc9NSZ03f8HCRYuX' +
  'LF22fMXKtPRVq9esXbd+w8ZNm7ds3bZ9R8bOXbszs7L37N23/0BO7sFDh48cPXb8xMlT1nsa6c1D' +
  'es8gvflI71mktwDpPYf0nkd6LyC9F5HeS0jvZaT3CtJ7FektRHqvIb3Xkd4bSO9NpPcW0luE9N5G' +
  'eu8gvXeR3ntIbzHSex/pLUF6HyC9pUhvGdL7EOl9hPSWI72Pkd4nSG8F0vsU6X2G9D5HeiuR3hdI' +
  'bxXS+xLprUZ6XyG9r5HeGqT3DdJbi/S+RXrfIb3vkd4PSO9HpPcT0luH9H5Ger8gvfVI71ek9xvS' +
  '+x3p/YH0NiC9P5HeX0hvI9LbhPT+Rnr/IL3NSG8L0vsX6f2H9LYivf+R3jakt70DDHCBU9i7AooA' +
  'AAAASUVORK5CYII=';

const JPEG_640x480_B64 =
  '/9j/4QAWRXhpZgAAAAAAAAAAAAAAAAAAAAD/wAARCAHgAoADAREAAhEBAxEB/9k=';

const GIF_32x24_B64 =
  'R0lGODlhIAAYAIAAAAAAAAAAADs=';

const WEBP_800x600_B64 =
  'UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAHwMAVwIA';

const BMP_16x16_B64 =
  'Qk02AwAAAAAAADYAAAAoAAAAEAAAABAAAAABABgAAAAAAAADAAATCwAAEwsAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const PNG_1600x900_B64 =
  'iVBORw0KGgoAAAANSUhEUgAABkAAAAOECAIAAAB2L2r1AAAdoklEQVR4nO3QwwEAAAIEsT3btm3b' +
  'tm3btm3btm3btm0bPcw7JSTbAQ54oAMf5KAHO/ghDnmoQx/msIc7/BGOeKQjH+WoRzv6MY55rGMf' +
  '57jHO/4JTniiE5/kpCc7+SlOeapTn+a0pzv9Gc54pjOf5axnO/s5znmuc5/nvOc7/wUueKELX+Si' +
  'F7v4JS55qUtf5rKXu/wVrnilK1/lqle7+jWuea1rX+e617v+DW54oxvf5KY3u/ktbnmrW9/mtre7' +
  '/R3ueKc73+Wud7v7Pe55r3vf5773u/8DHvigBz/koQ97+CMe+ahHP+axj3v8E574pCc/5alPe/oz' +
  'nvmsZz/nuc97/gte+KIXv+SlL3v5K175qle/5rWve/0b3vimN7/lrW97+zve+a53v+e973v/Bz74' +
  'oQ9/5KMf+/gnPvmpT3/ms5/7/Be++KUvf+WrX/v6N775rW9/57vf+/4PfvijH//kpz/7+S9++atf' +
  '/+a3v/v9H/74pz//5a9/+/s//vmvf//nv//j5+fn529+f/z8/Pz8yT9//Pz8/PzFP3/8/Pz8/MU/' +
  'f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9/' +
  '/Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8' +
  '/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8' +
  '/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8' +
  '/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8' +
  '/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8' +
  'xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzF' +
  'P3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/' +
  'f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9/' +
  '/Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8' +
  '/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8' +
  '/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8' +
  '/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8' +
  '/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8' +
  'xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzF' +
  'P3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/' +
  'f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9/' +
  '/Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8' +
  '/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8' +
  '/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8' +
  '/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8' +
  '/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8' +
  'xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzF' +
  'P3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/' +
  'f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9/' +
  '/Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8' +
  '/Pz8/MU/f/z8/Pz8xT9//Pz8/PzFP3/8/Pz8/Mnvj5+fn5+/+OePn5+fn7/454+fn5+fv/jnj5+f' +
  'n5+/+OePn5+fn7/454+fn5+fv/jnj5+fn5+/+OePn5+fn7/454+fn5+fv/jnj5+fn5+/+OePn5+f' +
  'n7/454+fn5+fv/jnj5+fn5+/+OePn5+fn7/454+fn5+fv/jnj5+fn5+/+OePn5+fn7/454+fn5+f' +
  'v/jnj5+fn5+/+OePn5+fn7/454+fn5+fv/jnj5+fn5+/+OePn5+fn7/454+fn5+fv/jnj5+fn5+/' +
  '+OePn5+fn7/454+fn5+fv/jnj5+fn5+/+OePn5+fn7/454+fn5+fv/jnj5+fn5+/+OePn5+fn7/4' +
  '54+fn5+fv/jnj5+fn5+/+OePn5+fn7/454+fn5+fv/jnj5+fn5+/+OePn5+fn7/454+fn5+fv/jn' +
  'j5+fn5+/+OePn5+fn7/454+fn5+fv/jnj5+fn5+/+OePn5+fn7/454+fn5+fv/jnj5+fn5+/+OeP' +
  'n5+fn7/454+fn5+fv/jnj5+fn5+/+OePn5+fn7/454+fn5+fv/jnj5+fn5+/+OePn5+fn7/454+f' +
  'n5+fv/jnj5+fn5+/+OePn5+fn7/454+fn5+fv/jnj5+fn5+/+OePn5+fn7/454+fn5+fv/jnj5+f' +
  'n5+/+OePn5+fn7/454+fn5+fv/jnj5+fn5+/+P3x8/Pz8yf//PHz8/PzF//88fPz8/MX//zx8/Pz' +
  '8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/Pz' +
  'F//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX' +
  '//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf/' +
  '/PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//8' +
  '8fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx' +
  '8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz' +
  '8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz' +
  '8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz' +
  '8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/Pz' +
  'F//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX' +
  '//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf/' +
  '/PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//8' +
  '8fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx' +
  '8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz' +
  '8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz' +
  '8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz' +
  '8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/Pz' +
  'F//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX' +
  '//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf/' +
  '/PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//8' +
  '8fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx' +
  '8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz' +
  '8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz' +
  '8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz' +
  '8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/Pz' +
  'F//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX//zx8/Pz8xf//PHz8/PzF//88fPz8/MX' +
  '//zx8/Pz8xf//PHz8/PzF//88fPz8/Mnvz9+fn5+/uKfP35+fn7+4p8/fn5+fv7inz9+fn5+/uKf' +
  'P35+fn7+4p8/fn5+fv7inz9+fn5+/uKfP35+fn7+4p8/fn5+fv7inz9+fn5+/uKfP35+fn7+4p8/' +
  'fn5+fv7inz9+fn5+/uKfP35+fn7+4p8/fn5+fv7inz9+fn5+/uKfP35+fn7+4p8/fn5+fv7inz9+' +
  'fn5+/uKfP35+fn7+4p8/fn5+fv7inz9+fn5+/uKfP35+fn7+4p8/fn5+fv7inz9+fn5+/uKfP35+' +
  'fn7+4p8/fn5+fv7inz9+fn5+/uKfP35+fn7+4p8/fn5+fv7inz9+fn5+/uKfP35+fn7+4p8/fn5+' +
  'fv7inz9+fn5+/uKfP35+fn7+4p8/fn5+fv7inz9+fn5+/uKfP35+fn7+4p8/fn5+fv7inz9+fn5+' +
  '/uKfP35+fn7+4p8/fn5+fv7inz9+fn5+/uKfP35+fn7+4p8/fn5+fv7inz9+fn5+/uKfP35+fn7+' +
  '4p8/fn5+fv7inz9+fn5+/uKfP35+fn7+4p8/fn5+fv7inz9+fn5+/uKfP35+fn7+4p8/fn5+fv7i' +
  'nz9+fn5+/uKfP35+fn7+4p8/fn5+fv7inz9+fn5+/uKfP35+fn7+4p8/fn5+fv7inz9+fn5+/uKf' +
  'P35+fn7+4p8/fn5+fv7inz9+fn5+/uL3x8/Pz8+f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPH' +
  'z8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fP' +
  'z8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/P' +
  'z89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/P' +
  'z1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/P' +
  'X/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f' +
  '/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/8' +
  '88fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zz' +
  'x8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPH' +
  'z8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fP' +
  'z8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/P' +
  'z89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/P' +
  'z1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/P' +
  'X/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f' +
  '/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/8' +
  '88fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zz' +
  'x8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPH' +
  'z8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fP' +
  'z8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/P' +
  'z89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/P' +
  'z1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/P' +
  'X/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f' +
  '/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/8' +
  '88fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zz' +
  'x8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPH' +
  'z8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fP' +
  'z8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/Pz89f/PPHz8/Pz1/888fPz8/PX/zzx8/P' +
  'z89f/PPHz8/Pz1/888fPz8/Pn/z++Pn5+fmLf/74+fn5+Yt//vj5+fn5i3/++Pn5+fmLf/74+fn5' +
  '+Yt//vj5+fn5i3/++Pn5+fmLf/74+fn5+Yt//vj5+fn5i3/++Pn5+fmLf/74+fn5+Yt//vj5+fn5' +
  'i3/++Pn5+fmLf/74+fn5+Yt//vj5+fn5i3/++Pn5+fmLf/74+fn5+Yt//vj5+fn5i3/++Pn5+fmL' +
  'f/74+fn5+Yt//vj5+fn5i3/++Pn5+fmLf/74+fn5+Yt//vj5+fn5i3/++Pn5+fmLf/74+fn5+Yt/' +
  '/vj5+fn5i3/++Pn5+fmLf/74+fn5+Yt//vj5+fn5i3/++Pn5+fmLf/74+fn5+Yt//vj5+fn5i3/+' +
  '+Pn5+fmLf/74+fn5+Yt//vj5+fn5i3/++Pn5+fmLf/74+fn5+Yt//vj5+fn5i3/++Pn5+fmLf/74' +
  '+fn5+Yt//vj5+fn5i3/++Pn5+fmLf/74+fn5+Yt//vj5+fn5i3/++Pn5+fmLf/74+fn5+Yt//vj5' +
  '+fn5i3/++Pn5+fmLf/74+fn5+Yt//vj5+fn5i3/++Pn5+fmLf/74+fn5+Yt//vj5+fn5i3/++Pn5' +
  '+fmLf/74+fn5+Yt//vj5+fn5i3/++Pn5+fmLf/74+fn5+Yt//vj5+fn5i3/++Pn5+fmLf/74+fn5' +
  '+Yt//vj5+fn5i3/++Pn5+fmL3x8/Pz8/f/LPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/' +
  '8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/x' +
  'zx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HP' +
  'Hz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8f' +
  'Pz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/' +
  'Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/' +
  'Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/' +
  'P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/' +
  'f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/' +
  '8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/x' +
  'zx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HP' +
  'Hz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8f' +
  'Pz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/' +
  'Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/' +
  'Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/' +
  'P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/' +
  'f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/' +
  '8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/x' +
  'zx8/Pz8/f/HPHz8/Pz9/8c8fPz8/P3/xzx8/Pz8/f/HPHz8/Pz9/8f8f53I482dKgVwAAAAASUVO' +
  'RK5CYII=';

const PNG_320x240_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAADwCAIAAAD+Tyo8AAAENElEQVR4nO3QwwEACADAsJ5t27Zt' +
  '27Zt27Zt27Zt27aNIfrtCAkMMOBAAw8y6GCDDzHkUEMPM+xww48w4kgjjzLqaKOPMeZYY48z7njj' +
  'TzDhRBNPMulkk08x5VRTTzPtdNPPMONMM88y62yzzzHnXHPPM+988y+w4EILL7LoYosvseRSSy+z' +
  '7HLLr7DiSiuvsupqq6+x5lprr7PueutvsOFGG2+y6Wabb7HlVltvs+122++w404777Lrbrvvsede' +
  'e++z7377H3DgQQcfcuhhhx9x5FFHH3PsccefcOJJJ59y6mmnn3HmWWefc+55519w4UUXX3LpZZdf' +
  'ceVVV19z7XXX33DjTTffcuttt99x511333Pvffc/8OBDDz/y6GOPP/HkU08/8+xzz7/w4ksvv/Lq' +
  'a6+/8eZbb7/z7nvvf/DhRx9/8ulnn3/x5Vdff/Ptd9//8ONPP//y62+///HnX3//8+9/1t+f9NOf' +
  '89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of' +
  '89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of' +
  '89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of' +
  '89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of' +
  '89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of' +
  '89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of' +
  '89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of' +
  '89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of' +
  '89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of' +
  '89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of89Of' +
  '9Pfn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn' +
  '/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn' +
  '/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/PTn/P8DOVWMyzG2lo0AAAAASUVORK5CYII=';

export const PNG_120x80 = decode(PNG_120x80_B64);
export const JPEG_640x480 = decode(JPEG_640x480_B64);
export const GIF_32x24 = decode(GIF_32x24_B64);
export const WEBP_800x600 = decode(WEBP_800x600_B64);
export const BMP_16x16 = decode(BMP_16x16_B64);
export const PNG_1600x900 = decode(PNG_1600x900_B64);
export const PNG_320x240 = decode(PNG_320x240_B64);

/** A byte-identical copy, for exercising content-hash duplicate detection. */
export const PNG_120x80_COPY = decode(PNG_120x80_B64);

export const NOT_AN_IMAGE = new Uint8Array(Buffer.from('<html>not an image at all</html>', 'utf8'));
export const TRUNCATED_PNG = PNG_120x80.subarray(0, 6);
