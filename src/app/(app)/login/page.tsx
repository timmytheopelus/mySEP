import LoginForm from "./login-form";
import styles from "./login.module.css";

export const metadata = { title: "Masuk - KEP Keuskupan Bandung" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const step = q.step === "mfa" || q.step === "enroll" ? q.step : undefined;
  return (
    <main className={styles.main}>
      <h1>Masuk</h1>
      <LoginForm initial={{ step, googleError: q.error === "google" }} />
    </main>
  );
}
