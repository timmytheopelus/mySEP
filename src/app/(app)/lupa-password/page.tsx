import Form from "./form";
import styles from "../forms.module.css";

export const metadata = { title: "Lupa password - KEP Keuskupan Bandung" };

export default function Page() {
  return (
    <main className={styles.main}>
      <h1>Lupa password</h1>
      <Form />
    </main>
  );
}
