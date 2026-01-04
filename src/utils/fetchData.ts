import axios from "axios";

export async function fetchData<T>(url: string): Promise<T> {
  try {
    const response = await axios.get<T>(url);
    return response.data;
  } catch (error) {
    console.error(`Error fetching data from ${url}:`, error);
    throw error;
  }
}

export async function postData<T, R>(url: string, data: T): Promise<R> {
  try {
    const response = await axios.post<R>(url, data);
    return response.data;
  } catch (error) {
    console.error(`Error posting data to ${url}:`, error);
    throw error;
  }
}

export default fetchData;
