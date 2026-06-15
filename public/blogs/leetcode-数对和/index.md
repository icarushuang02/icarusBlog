## 题目描述

设计一个算法，找出数组中两数之和为指定值的所有整数对。一个数只能属于一个数对。

**示例 1：**

```
**输入：**nums = [5,6,5], target = 11
**输出：**[[5,6]]
```

**示例 2：**

```
**输入：**nums = [5,6,5,6], target = 11
**输出：**[[5,6],[5,6]]
```

**提示：**

	- `nums.length <= 100000`

	- `-105 <= nums[i], target <= 105`

## 解法

```java
class Solution {
    public List<List<Integer>> pairSums(int[] nums, int target) {
          if (nums.length == 0) return new ArrayList<>();
        Map<Integer,Integer> map=new HashMap<>();
        List<List<Integer>> ans = new ArrayList<>();
        for(int num:nums){
            if(map.getOrDefault(target-num,0)>0){
                ans.add(Arrays.asList(target-num, num));
                map.put(target-num,map.get(target-num)-1);
            }else{
                map.merge(num,1,Integer::sum);
            }
        }
        return ans;
    }
}


```
