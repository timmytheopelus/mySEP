import LoginForm from "./login-form";
import styles from "./login.module.css";

export const metadata = { title: "Masuk - KEP Keuskupan Bandung" };

export default function LoginPage() {
  return (
    <main className={styles.main}>
      <h1>Masuk</h1>
      <LoginForm />
    </main>
  );
}
