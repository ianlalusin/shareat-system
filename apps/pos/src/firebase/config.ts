
import { emulatorProfile } from '../../config/emulator-profile.mjs';
const emulator = emulatorProfile(process.env.NEXT_PUBLIC_POS_EMULATOR_MODE, process.env.NEXT_PUBLIC_POS_EMULATOR_HOST);

export const firebaseConfig = emulator ? {
  apiKey: 'emulator-only-not-a-real-key',
  authDomain: `${emulator.projectId}.firebaseapp.com`,
  projectId: emulator.projectId,
  storageBucket: `${emulator.projectId}.appspot.com`,
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:emulator',
} : {
  apiKey: "AIzaSyBU1LQcbMS6aAQZrE2eXfrAd3mxv-56q4Y",
  authDomain: "shareat-hub-v2.firebaseapp.com",
  projectId: "shareat-hub-v2",
  storageBucket: "shareat-hub-v2.firebasestorage.app",
  messagingSenderId: "330037713504",
  appId: "1:330037713504:web:88960a43640431b92c0105",
  measurementId: "G-97G400VQE7"
};
